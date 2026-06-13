using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PatientSyncApi.Services;

/// <summary>
/// Sends transactional emails via the MXroute HTTP SMTP API.
/// https://docs.mxroute.com/docs/api/smtp-api.html
///
/// SECURITY:
///   - Credentials are read from IConfiguration (appsettings / env vars).
/// </summary>
public sealed class EmailService
{
    private readonly IConfiguration        _config;
    private readonly ILogger<EmailService> _logger;

    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public EmailService(IConfiguration config, ILogger<EmailService> logger)
    {
        _config = config;
        _logger = logger;
    }

    // â”€â”€ shared HTTP send â€” every public method calls this â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    private async Task<bool> SendViaMxRouteAsync(string toEmail, string subject, string htmlBody)
    {
        var from     = _config["Email:From"]     ?? "info@etbr.org";
        var server   = _config["Email:Server"]   ?? "witcher.mxrouting.net";
        var username = _config["Email:Username"] ?? string.Empty;
        var password = _config["Email:Password"] ?? string.Empty;

        var payload = new
        {
            server,
            username,
            password,
            from,
            to      = toEmail,
            subject,
            body    = htmlBody
        };

        var json    = JsonSerializer.Serialize(payload, _jsonOptions);
        var content = new StringContent(json, Encoding.UTF8, "application/json");

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };

        _logger.LogInformation("Sending email '{Subject}' to {Email} via MXroute HTTP API.", subject, toEmail);

        var resp     = await http.PostAsync("https://smtpapi.mxroute.com/", content);
        var respBody = await resp.Content.ReadAsStringAsync();

        _logger.LogInformation("MXroute response: {Status} {Body}", (int)resp.StatusCode, respBody);

        if (!resp.IsSuccessStatusCode)
        {
            _logger.LogWarning("MXroute HTTP {Status} for {Email}: {Body}",
                (int)resp.StatusCode, toEmail, respBody);
            return false;
        }

        using var doc = JsonDocument.Parse(respBody);
        if (doc.RootElement.TryGetProperty("success", out var s) && s.ValueKind == JsonValueKind.True)
        {
            _logger.LogInformation("Email '{Subject}' sent OK to {Email}.", subject, toEmail);
            return true;
        }

        var msg = doc.RootElement.TryGetProperty("message", out var m) ? m.GetString() : respBody;
        _logger.LogWarning("MXroute rejected email '{Subject}' to {Email}: {Msg}", subject, toEmail, msg);
        return false;
    }

    public async Task<bool> SendPasswordResetCodeAsync(string toEmail, string code)
    {
        var htmlBody = $"""
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
              <h2 style="color:#2c7a4b;">eTBr Password Reset</h2>
              <p>Hello,</p>
              <p>We received a request to reset your eTBr account password.</p>
              <p>Enter the following 6-digit code on the reset page:</p>
              <div style="font-size:2.2em;font-weight:bold;letter-spacing:0.35em;
                          background:#f4f4f4;padding:14px 20px;border-radius:6px;
                          display:inline-block;margin:8px 0;">{code}</div>
              <p>This code expires in <strong>30 minutes</strong>.</p>
              <p>If you did not request a password reset, you can safely ignore this email.</p>
              <br/>
              <p style="color:#666;font-size:0.85em;">eTBr Team</p>
            </div>
            """;

        try
        {
            return await SendViaMxRouteAsync(toEmail, "eTBr - Your Password Reset Code", htmlBody);
        }
        catch (TaskCanceledException)
        {
            _logger.LogError("MXroute request timed out sending reset-code email to {Email}.", toEmail);
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "MXroute error sending reset-code email to {Email}.", toEmail);
            return false;
        }
    }

    public async Task<bool> SendPasswordChangedAsync(string toEmail, string fullName)
    {
        var htmlBody = """
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
              <h2 style="color:#2c7a4b;">eTBr Account Update</h2>
              <p>Hello,</p>
              <p>This is a confirmation that your eTBr account password has been successfully updated.</p>
              <p>If you did not make this change, please contact your administrator immediately.</p>
              <br/>
              <p style="color:#666;font-size:0.85em;">eTBr Team</p>
            </div>
            """;

        try
        {
            return await SendViaMxRouteAsync(toEmail, "eTBr - Account Update Confirmation", htmlBody);
        }
        catch (TaskCanceledException)
        {
            _logger.LogError("MXroute request timed out sending password-changed email to {Email}.", toEmail);
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "MXroute error sending password-changed email to {Email}.", toEmail);
            return false;
        }
    }
}
