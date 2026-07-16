using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.IdentityModel.Tokens;
using PatientSyncApi.Middleware;
using PatientSyncApi.Services;

var builder = WebApplication.CreateBuilder(args);

// ─── Services ────────────────────────────────────────────────────────────────

builder.Services.AddControllers();

// IMemoryCache is used by the SSE report-progress endpoint to cache the
// finished Excel workbook between stream completion and the download request.
builder.Services.AddMemoryCache();

// TokenService generates signed JWTs for authenticated users.
builder.Services.AddScoped<TokenService>();

// EmailService sends transactional emails via SMTP (MailKit).
builder.Services.AddScoped<EmailService>();

// AuditService writes rows to LogT. IHttpContextAccessor is required so
// the service can read the current user's JWT claims without them being
// passed manually on every call site.
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<AuditService>();

// LegacyMigrationService copies historical records from the legacy
// Access-sourced database (db_ac602a_etbrss) into the new database,
// one DataSourceID (facility) at a time, on demand.
builder.Services.AddScoped<LegacyMigrationService>();

// MigrationProgressService holds in-memory progress state for running
// migrations. Must be a singleton so progress survives individual HTTP
// requests and can be polled by the PWA progress bar.
builder.Services.AddSingleton<MigrationProgressService>();

// IHttpClientFactory is used by Dhis2Controller to POST report data to DHIS2.
// Named client "dhis2" can be configured further here if needed (e.g., timeout).
builder.Services.AddHttpClient("dhis2", client =>
{
    client.Timeout = TimeSpan.FromSeconds(60);
});

// ── JWT Authentication ────────────────────────────────────────────────────────
// Tokens are issued by AuthController.Login and must be included in subsequent
// requests as:  Authorization: Bearer <token>
//
// SECURITY: The signing key must be kept secret and must be at least 32 bytes.
//           Set Jwt:Key via environment variable or dotnet user-secrets —
//           never commit a real key to source control.
var jwtKey = builder.Configuration["Jwt:Key"]
    ?? throw new InvalidOperationException(
        "Jwt:Key is not configured. Set it in appsettings.json or as an environment variable.");

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer           = true,
            ValidateAudience         = true,
            ValidateLifetime         = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer              = builder.Configuration["Jwt:Issuer"],
            ValidAudience            = builder.Configuration["Jwt:Audience"],
            IssuerSigningKey         = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
            // No grace period — tokens expire exactly when ExpiresAt says.
            ClockSkew                = TimeSpan.Zero
        };
        // Return a JSON 401 instead of a redirect so the PWA can handle it.
        options.Events = new JwtBearerEvents
        {
            // ── Read JWT from HttpOnly cookie (primary) ───────────────────────
            // The PWA stores the token in an HttpOnly cookie set by the login
            // endpoint so JavaScript cannot read or steal it (mitigates XSS token
            // theft).  If the cookie is present we use it; otherwise we fall back
            // to the Authorization: Bearer header for any legacy / tool callers.
            OnMessageReceived = ctx =>
            {
                if (ctx.Request.Cookies.TryGetValue("art.jwt", out var cookieToken)
                    && !string.IsNullOrEmpty(cookieToken))
                {
                    ctx.Token = cookieToken;
                }
                return Task.CompletedTask;
            },
            OnChallenge = async ctx =>
            {
                ctx.HandleResponse();
                ctx.Response.StatusCode  = 401;
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsJsonAsync(new { error = "Unauthorized." });
            },
            OnForbidden = async ctx =>
            {
                ctx.Response.StatusCode  = 403;
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsJsonAsync(new { error = "You do not have permission to perform this action." });
            }
        };
    });

builder.Services.AddAuthorization();

// ── CORS ──────────────────────────────────────────────────────────────────────
// SECURITY: Never use AllowAnyOrigin() in production. Doing so would allow any
//           website on the internet to send sync requests and potentially forward
//           patient data to a third party or flood the database with junk records.
//
// GET is added alongside POST so the lookup endpoint is reachable from the PWA.
// Authorization header is whitelisted so the PWA can send JWT bearer tokens.
// AllowCredentials() is required so the browser sends the HttpOnly auth cookie
// on cross-origin requests (art.etbr.org → api.etbr.org).  This is safe because
// we use WithOrigins() — never AllowAnyOrigin() — so only our own PWA can
// trigger credentialed requests.

var allowedOrigins = builder.Configuration
    .GetSection("AllowedOrigins")
    .Get<string[]>() ?? Array.Empty<string>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("GitHubPagesCors", policy =>
        policy
            .WithOrigins(allowedOrigins)
            .WithMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
            .WithHeaders("Content-Type", "X-Api-Key", "Authorization")
            .WithExposedHeaders("Content-Disposition")
            .AllowCredentials());
});

// ─── Pipeline ─────────────────────────────────────────────────────────────────

var app = builder.Build();

// CLOUDFLARE PROXY COMPATIBILITY:
// When Cloudflare proxies requests, it terminates HTTPS and forwards requests
// to the origin server over HTTP internally. UseHttpsRedirection() would cause
// an infinite redirect loop in that scenario, so it is replaced with
// ForwardedHeaders middleware which correctly reads the X-Forwarded-Proto header
// that Cloudflare injects, letting the app know the original request was HTTPS.
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
});

// Apply the CORS policy BEFORE routing so that browser preflight (OPTIONS) requests
// receive the correct Access-Control-Allow-* headers even before the middleware chain
// has a chance to validate the API key (the browser sends no key in a preflight).
app.UseCors("GitHubPagesCors");

// API key check for legacy callers (PWA sync before JWT migration).
// Skips /api/auth/* (public endpoints) and any request already carrying a
// valid Bearer token (JWT authentication handles those).
// Must come AFTER UseCors so preflight requests are not blocked.
app.UseMiddleware<ApiKeyMiddleware>();

// JWT authentication + role-based authorisation.
// Must come AFTER the API key middleware and BEFORE MapControllers.
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
