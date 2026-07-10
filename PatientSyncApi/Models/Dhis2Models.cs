namespace PatientSyncApi.Models;

// ─── Inbound query / request models ──────────────────────────────────────────

/// <summary>
/// Query parameters for GET /api/dhis2/tb-prepare.
/// CF = Case Finding period (primary).
/// SC = Sputum Conversion period (defaults to CF-2 quarters).
/// TO = Treatment Outcome period  (defaults to CF-5 quarters).
/// </summary>
public sealed record TbPrepareQuery(
    int     CfQuarter,
    int     CfYear,
    int?    ScQuarter   = null,
    int?    ScYear      = null,
    int?    ToQuarter   = null,
    int?    ToYear      = null);

/// <summary>
/// Request body for POST /api/dhis2/tb-send.
/// </summary>
public sealed class TbSendRequest
{
    /// <summary>DHIS2 orgUnit UIDs of the facilities to submit (selected by user).</summary>
    public List<string> FacilityUids { get; set; } = new();
    public int CfQuarter  { get; set; }
    public int CfYear     { get; set; }
    public int? ScQuarter { get; set; }
    public int? ScYear    { get; set; }
    public int? ToQuarter { get; set; }
    public int? ToYear    { get; set; }
}

// ─── Outbound DTOs ────────────────────────────────────────────────────────────

/// <summary>
/// Summary row returned by the Prepare endpoint — one per facility with data.
/// Used by the frontend to build the facility selection table (screenshot).
/// </summary>
public sealed record FacilityReportDto(
    string Uid,
    string FacilityName,
    string County,
    string State,
    string StateShort,
    string Period,         // e.g., "Q1 2026"
    int    TotalCfValues,  // total non-zero case-finding values — for display
    int    TotalToValues); // total non-zero outcome values

/// <summary>
/// Result of the Send action: which facilities succeeded and which failed.
/// </summary>
public sealed record TbSendResultDto(
    List<FacilityResultItem> Succeeded,
    List<FacilityResultItem> Failed);

public sealed record FacilityResultItem(string FacilityName, string Uid, string? ErrorDetail = null);
