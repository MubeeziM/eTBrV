using System.Security.Claims;
using Microsoft.Data.SqlClient;
using Microsoft.IdentityModel.JsonWebTokens;

namespace PatientSyncApi.Services;

/// <summary>
/// Writes structured audit entries to LogT.
///
/// Usage (authenticated endpoints — UserTID read automatically from JWT):
///     await _audit.LogAsync("Synced 5 patient records");
///     await _audit.LogAsync("Facility transfer for patient X", patientId: ptId);
///
/// Usage (auth-flow endpoints without a JWT yet — pass the UserTID explicitly):
///     await _audit.LogAsync("User logged in", userTID: tokenData.UserTID);
///     await _audit.LogAsync("New user registered", userTID: newUserTID);
///
/// Usage (error events):
///     await _audit.LogErrorAsync("Sync failed", ex, context: "POST /api/patients/sync-full");
///
/// SAFETY: This method never throws. If the DB insert fails it falls back to
/// ILogger so the caller's response is never affected by a logging failure.
/// </summary>
public sealed class AuditService
{
    private readonly string                _connectionString;
    private readonly IHttpContextAccessor  _httpContextAccessor;
    private readonly ILogger<AuditService> _logger;

    public AuditService(
        IConfiguration        config,
        IHttpContextAccessor  httpContextAccessor,
        ILogger<AuditService> logger)
    {
        _connectionString    = config.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("DefaultConnection is not configured.");
        _httpContextAccessor = httpContextAccessor;
        _logger              = logger;
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  LogAsync — general activity / business-event logging
    //
    //  patientId   : the PtDetailsTID GUID string if the action is patient-linked.
    //  userTID     : override the JWT-derived user (use for auth-flow endpoints
    //                that don't yet have a token, e.g. login, register).
    // ──────────────────────────────────────────────────────────────────────────
    public async Task LogAsync(string notes, string? patientId = null, string? userTID = null)
    {
        var resolvedUser = userTID ?? GetCurrentUserTID();
        await InsertAsync(notes, patientId, resolvedUser);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  LogErrorAsync — error / exception logging
    //
    //  Appends the context (endpoint / action name) and the exception type +
    //  message to the notes so the row is self-contained for audit review.
    //
    //  Example result in Notes:
    //    "Full sync failed | POST /api/patients/sync-full | SqlException: ..."
    // ──────────────────────────────────────────────────────────────────────────
    public async Task LogErrorAsync(
        string     notes,
        Exception  ex,
        string?    context   = null,
        string?    patientId = null,
        string?    userTID   = null)
    {
        var contextPart = context is not null ? $" | {context}" : string.Empty;
        var exPart      = $" | {ex.GetType().Name}: {ex.Message}";

        // Truncate to avoid absurdly long notes if ex.Message is huge.
        const int MaxLength = 4000;
        var fullNote = $"{notes}{contextPart}{exPart}";
        if (fullNote.Length > MaxLength)
            fullNote = fullNote[..MaxLength];

        var resolvedUser = userTID ?? GetCurrentUserTID();
        await InsertAsync(fullNote, patientId, resolvedUser);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Private helpers
    // ──────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Reads the current user's TID from the JWT claims attached to the active
    /// HTTP request. Returns null when there is no authenticated user (e.g. on
    /// the login or registration endpoints).
    /// </summary>
    private string? GetCurrentUserTID()
    {
        var user = _httpContextAccessor.HttpContext?.User;
        if (user is null) return null;

        return user.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? user.FindFirstValue(JwtRegisteredClaimNames.Sub);
    }

    /// <summary>
    /// Inserts one row into LogT. Never throws — logs to ILogger on failure.
    /// </summary>
    private async Task InsertAsync(string notes, string? patientId, string? resolvedUserTID)
    {
        const string sql =
            "INSERT INTO LogT (PtDetailsTID, Notes, UserTID) VALUES (@PtDetailsTID, @Notes, @UserTID)";

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var cmd = new SqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@Notes",       notes);
            cmd.Parameters.AddWithValue("@PtDetailsTID", (object?)patientId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("@UserTID",      (object?)resolvedUserTID ?? DBNull.Value);
            await cmd.ExecuteNonQueryAsync();
        }
        catch (Exception ex)
        {
            // Logging must never break the caller. Fall back to the structured
            // application log so the event is not silently lost.
            _logger.LogError(ex,
                "AuditService failed to write to LogT. Original notes: {Notes}", notes);
        }
    }
}
