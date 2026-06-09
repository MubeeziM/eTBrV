namespace PatientSyncApi.Middleware;

/// <summary>
/// ASP.NET Core middleware that enforces a shared API key for all /api/* routes.
///
/// HOW IT WORKS:
///   Every request to /api/* must include the header:
///     X-Api-Key: &lt;the value stored in appsettings.json "ApiKey"&gt;
///   Requests without the correct header receive 401 Unauthorized.
///
/// SECURITY NOTE — KNOWN LIMITATION:
///   The API key is embedded in the PWA's JavaScript bundle, which is served
///   publicly. Any user who opens DevTools can read it. This is inherent to
///   all purely client-side secrets and CANNOT be fully mitigated on the
///   frontend.
///
///   The key still provides meaningful defence-in-depth:
///     - Stops anonymous internet scanners and bots from submitting data.
///     - Allows quick invalidation (rotate the key) if it is leaked.
///
///   For stronger security in production, layer on top of this:
///     1. HTTPS (mandatory — encrypts the key in transit).
///     2. Proper user authentication: issue short-lived JWT tokens after login
///        so individual users can be revoked without rotating the shared key.
///     3. IP allow-listing if the deployment scenario permits it.
///     4. Rate limiting (e.g. ASP.NET Core rate-limiting middleware) to cap
///        how many records any single client can submit per minute.
/// </summary>
public sealed class ApiKeyMiddleware
{
    private const string ApiKeyHeader = "X-Api-Key";

    private readonly RequestDelegate _next;
    private readonly string _validKey;

    public ApiKeyMiddleware(RequestDelegate next, IConfiguration config)
    {
        _next = next;

        // Read from appsettings.json / environment variable — NEVER hard-code here.
        _validKey = config["ApiKey"]
            ?? throw new InvalidOperationException(
                "ApiKey is not configured. Set it in appsettings.json or as an environment variable.");
    }

    public async Task InvokeAsync(HttpContext context)
    {
        // Only guard /api/* routes; allow OPTIONS preflight through so CORS works.
        if (context.Request.Path.StartsWithSegments("/api")
            && !HttpMethods.IsOptions(context.Request.Method))
        {
            if (!context.Request.Headers.TryGetValue(ApiKeyHeader, out var providedKey)
                || !string.Equals(providedKey, _validKey, StringComparison.Ordinal))
            {
                // Return 401 with a generic message.
                // SECURITY: Do NOT reveal whether the key is missing or wrong —
                //           that distinction helps attackers enumerate.
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                await context.Response.WriteAsJsonAsync(new { error = "Unauthorized." });
                return;
            }
        }

        await _next(context);
    }
}
