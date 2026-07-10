using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.IdentityModel.JsonWebTokens;
using PatientSyncApi.Models;

namespace PatientSyncApi.Controllers;

/// <summary>
/// Receives offline audit log entries from the PWA and writes them to the
/// server's LogT table, completing the central audit trail.
///
/// The PWA records patient-data mutations and Excel exports locally in
/// AuditLogT while the device is offline.  On the next successful sync the
/// PWA POSTs those rows here so they are permanently stored server-side.
///
/// SECURITY:
///   - [Authorize] ensures only authenticated users can submit logs.
///   - Notes and UserName are truncated server-side to match LogT column limits.
///   - All SQL uses parameterised queries — no string concatenation (OWASP A03).
///   - The action code is validated against an allowed-list to prevent injection
///     of arbitrary text into the Action field.
/// </summary>
[ApiController]
[Route("api/audit-logs")]
[Authorize]
public sealed class AuditLogsController : ControllerBase
{
    private static readonly HashSet<string> _allowedActions = new(StringComparer.OrdinalIgnoreCase)
    {
        "CREATE_ART", "UPDATE_ART", "DELETE_ART", "UNDELETE_ART",
        "CREATE_ART_VISIT", "UPDATE_ART_VISIT",
        "CREATE_TB",  "UPDATE_TB",  "DELETE_TB",  "UNDELETE_TB",
        "EXPORT_ART", "EXPORT_TB",  "EXPORT_MON", "EXPORT_DQ",
    };

    private readonly string _connectionString;
    private readonly ILogger<AuditLogsController> _logger;

    public AuditLogsController(IConfiguration config, ILogger<AuditLogsController> logger)
    {
        _connectionString = config.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("DefaultConnection is not configured.");
        _logger = logger;
    }

    // ── POST /api/audit-logs ─────────────────────────────────────────────────
    // Accepts a JSON array of AuditLogEntry objects from the PWA and inserts
    // each one into LogT.  Returns the count of rows written.
    // ─────────────────────────────────────────────────────────────────────────
    [HttpPost]
    public async Task<IActionResult> Push([FromBody] List<AuditLogEntry>? entries)
    {
        if (entries is null || entries.Count == 0)
            return BadRequest(new { error = "No audit log entries provided." });

        if (entries.Count > 500)
            return BadRequest(new { error = "Batch size exceeds the maximum of 500 entries." });

        // ── Resolve the server-side user TID from the JWT ─────────────────────
        // We use the JWT's subject claim as the authoritative UserTID so the
        // client cannot submit logs attributed to a different user.
        var jwtUserTID = User.FindFirstValue(ClaimTypes.NameIdentifier)
                      ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub);

        const string insertSql =
            @"INSERT INTO LogT (LoggedOn, PtDetailsTID, Notes, UserTID)
              VALUES (@LoggedOn, @PtDetailsTID, @Notes, @UserTID)";

        int written = 0;
        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            foreach (var entry in entries)
            {
                // ── Validate the action code against a strict allow-list ───────
                var action = _allowedActions.Contains(entry.Action ?? string.Empty)
                    ? entry.Action!
                    : "UNKNOWN";

                // ── Build the Notes string written to LogT ────────────────────
                // Format:  [PWA-OFFLINE] ACTION: human notes (by DisplayName)
                var displayName = (entry.UserName ?? string.Empty).Trim();
                var humanNotes  = (entry.Notes    ?? string.Empty).Trim();
                var rawNotes    = $"[PWA-OFFLINE] {action}: {humanNotes}"
                    + (displayName.Length > 0 ? $" (by {displayName})" : string.Empty);

                // Truncate to LogT.Notes column limit (NVARCHAR 4000)
                if (rawNotes.Length > 4000) rawNotes = rawNotes[..4000];

                // ── Parse the client-supplied LoggedOn timestamp ───────────────
                // Fall back to UTC now if the value is missing or unparseable.
                if (!DateTime.TryParse(entry.LoggedOn, out var loggedOn))
                    loggedOn = DateTime.UtcNow;

                // ── Parse PtDetailsTID — must be a valid GUID ─────────────────
                string? ptId = Guid.TryParse(entry.PtDetailsTID, out _)
                    ? entry.PtDetailsTID
                    : null;

                await using var cmd = new SqlCommand(insertSql, conn);
                cmd.Parameters.AddWithValue("@LoggedOn",     loggedOn);
                cmd.Parameters.AddWithValue("@PtDetailsTID", (object?)ptId ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Notes",        rawNotes);
                cmd.Parameters.AddWithValue("@UserTID",      (object?)jwtUserTID ?? DBNull.Value);
                await cmd.ExecuteNonQueryAsync();
                written++;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "AuditLogsController: failed to write {Count} entries to LogT.", entries.Count);
            return StatusCode(500, new { error = "An error occurred writing audit logs. Please try again." });
        }

        _logger.LogInformation("AuditLogsController: wrote {Written} offline audit entries to LogT.", written);
        return Ok(new { message = $"Recorded {written} audit log entries.", written });
    }
}
