using Microsoft.AspNetCore.HttpOverrides;
using PatientSyncApi.Middleware;

var builder = WebApplication.CreateBuilder(args);

// ─── Services ────────────────────────────────────────────────────────────────

builder.Services.AddControllers();

// CORS policy — only the origins listed in "AllowedOrigins" are permitted.
//
// SECURITY: Never use AllowAnyOrigin() in production. Doing so would allow any
//           website on the internet to send sync requests and potentially forward
//           patient data to a third party or flood the database with junk records.
//
// SECURITY: Only POST and OPTIONS (preflight) are allowed. OPTIONS is required
//           by the browser's CORS preflight mechanism before the actual POST.
//
// SECURITY: Only the two headers the PWA actually sends are whitelisted.
//           Credentials (cookies / auth headers) are explicitly disallowed because
//           this API uses API-key authentication, not cookie-based sessions.

var allowedOrigins = builder.Configuration
    .GetSection("AllowedOrigins")
    .Get<string[]>() ?? Array.Empty<string>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("GitHubPagesCors", policy =>
        policy
            .WithOrigins(allowedOrigins)            // set in appsettings.json
            .WithMethods("POST", "OPTIONS")
            .WithHeaders("Content-Type", "X-Api-Key")
            .DisallowCredentials());
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

// Validate the X-Api-Key header for all /api/* routes.
// Must come AFTER UseCors so preflight requests are not blocked.
app.UseMiddleware<ApiKeyMiddleware>();

app.MapControllers();

app.Run();
