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

    public async Task<bool> SendAccountApprovedAsync(string toEmail, string fullName)
    {
        var htmlBody = $"""
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
              <h2 style="color:#2c7a4b;">eTBr Account Approved</h2>
              <p>Dear {System.Net.WebUtility.HtmlEncode(fullName)},</p>
              <p>Your eTBr account has been <strong>approved</strong>. You can now sign in at:</p>
              <p style="margin:12px 0;">
                <a href="https://art.etbr.org" style="background:#2c7a4b;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;font-weight:bold;">
                  Sign In to eTBr
                </a>
              </p>
              <p>If you have any questions, please contact your supervisor.</p>
              <br/>
              <p style="color:#666;font-size:0.85em;">eTBr Team</p>
            </div>
            """;

        try
        {
            return await SendViaMxRouteAsync(toEmail, "eTBr - Your Account Has Been Approved", htmlBody);
        }
        catch (TaskCanceledException)
        {
            _logger.LogError("MXroute request timed out sending account-approved email to {Email}.", toEmail);
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "MXroute error sending account-approved email to {Email}.", toEmail);
            return false;
        }
    }

    public async Task<bool> SendAccountRejectedAsync(string toEmail, string fullName)
    {
        var htmlBody = $"""
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
              <h2 style="color:#b91c1c;">eTBr Account Registration</h2>
              <p>Dear {System.Net.WebUtility.HtmlEncode(fullName)},</p>
              <p>We regret to inform you that your eTBr account registration could not be approved at this time.</p>
              <p>If you believe this is an error or require further assistance, please contact your programme administrator.</p>
              <br/>
              <p style="color:#666;font-size:0.85em;">eTBr Team</p>
            </div>
            """;

        try
        {
            return await SendViaMxRouteAsync(toEmail, "eTBr - Account Registration Update", htmlBody);
        }
        catch (TaskCanceledException)
        {
            _logger.LogError("MXroute request timed out sending account-rejected email to {Email}.", toEmail);
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "MXroute error sending account-rejected email to {Email}.", toEmail);
            return false;
        }
    }

    /// <summary>
    /// Sent to the user after they successfully update their own profile
    /// (display name, username, email, phone, or avatar).
    /// </summary>
    public async Task<bool> SendProfileChangedAsync(string toEmail, string fullName)
    {
        var safeFullName = System.Net.WebUtility.HtmlEncode(fullName);
        var htmlBody = $"""
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
              <h2 style="color:#2c7a4b;">eTBr Account Update</h2>
              <p>Dear {safeFullName},</p>
              <p>Your eTBr account profile was updated successfully.</p>
              <p>If you did not make this change, please contact your administrator immediately at
                 <a href="mailto:micah@etbr.org">micah@etbr.org</a>.</p>
              <br/>
              <p style="color:#666;font-size:0.85em;">eTBr Team</p>
            </div>
            """;

        try
        {
            return await SendViaMxRouteAsync(toEmail, "eTBr - Profile Updated", htmlBody);
        }
        catch (TaskCanceledException)
        {
            _logger.LogError("MXroute timed out sending profile-changed email to {Email}.", toEmail);
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "MXroute error sending profile-changed email to {Email}.", toEmail);
            return false;
        }
    }

    /// <summary>
    /// Sent to the admin (micah@etbr.org) whenever a user updates their own profile.
    /// For awareness only — no action required from the admin.
    /// </summary>
    public async Task<bool> SendAdminProfileChangedNotifyAsync(
        string adminEmail, string userFullName, string userName)
    {
        var safeName  = System.Net.WebUtility.HtmlEncode(userFullName);
        var safeUser  = System.Net.WebUtility.HtmlEncode(userName);
        var htmlBody  = $"""
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
              <h2 style="color:#2c7a4b;">eTBr — Profile Update Notification</h2>
              <p>This is an automated notification.</p>
              <p>The following user has updated their eTBr account profile:</p>
              <table style="border-collapse:collapse;width:100%;margin:12px 0;">
                <tr><td style="padding:6px 10px;font-weight:600;background:#f4f4f4">Full Name</td>
                    <td style="padding:6px 10px;">{safeName}</td></tr>
                <tr><td style="padding:6px 10px;font-weight:600;background:#f4f4f4">Username</td>
                    <td style="padding:6px 10px;">{safeUser}</td></tr>
                <tr><td style="padding:6px 10px;font-weight:600;background:#f4f4f4">Time (UTC)</td>
                    <td style="padding:6px 10px;">{DateTime.UtcNow:yyyy-MM-dd HH:mm} UTC</td></tr>
              </table>
              <p style="color:#6b7280;font-size:0.85em;">
                No action is required. This notification is for your records only.
              </p>
              <br/>
              <p style="color:#666;font-size:0.85em;">eTBr System</p>
            </div>
            """;

        try
        {
            return await SendViaMxRouteAsync(adminEmail, $"eTBr — Profile Updated: {safeUser}", htmlBody);
        }
        catch (TaskCanceledException)
        {
            _logger.LogError("MXroute timed out sending admin profile-change notify.");
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "MXroute error sending admin profile-change notify.");
            return false;
        }
    }
}
