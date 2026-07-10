namespace PatientSyncApi.Models;

/// <summary>
/// Represents one offline audit log entry sent from the PWA's local AuditLogT
/// table to the server's LogT table.
///
/// The PWA records every patient-data mutation (create / update / delete /
/// undelete / follow-up save) and every Excel export while offline.  When the
/// user next connects to the internet these rows are POSTed here and written
/// to LogT so the central audit trail is complete.
/// </summary>
public sealed class AuditLogEntry
{
    /// <summary>Local SQLite row id — used by the PWA to mark rows as synced.</summary>
    public long   AuditLogID   { get; set; }

    /// <summary>ISO-8601 timestamp of when the action occurred on the device.</summary>
    public string LoggedOn     { get; set; } = string.Empty;

    /// <summary>
    /// Short action code: CREATE_ART, UPDATE_ART, DELETE_ART, UNDELETE_ART,
    /// CREATE_ART_VISIT, UPDATE_ART_VISIT, CREATE_TB, UPDATE_TB, DELETE_TB,
    /// UNDELETE_TB, EXPORT_ART, EXPORT_TB, EXPORT_MON, EXPORT_DQ.
    /// </summary>
    public string Action       { get; set; } = string.Empty;

    /// <summary>PtDetailsTID (GUID string) of the patient concerned, if applicable.</summary>
    public string? PtDetailsTID { get; set; }

    /// <summary>Human-readable description of the action.</summary>
    public string Notes        { get; set; } = string.Empty;

    /// <summary>UserTID (GUID string) of the user who performed the action.</summary>
    public string? UserTID     { get; set; }

    /// <summary>Display name of the user (full name or username).</summary>
    public string? UserName    { get; set; }
}
