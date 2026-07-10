using System.Text.Json.Serialization;

namespace PatientSyncApi.Models;

/// <summary>
/// Baseline cumulative ART patient counts for a single facility as of a
/// specific cut-off date.  Returned by GET /api/baseline/{facilityId}.
/// </summary>
public sealed class FacilityBaselineDto
{
    public int    HealthFacilityID { get; set; }
    public string FacilityName     { get; set; } = string.Empty;

    /// <summary>ISO date (yyyy-MM-dd) — last day of the baseline month, e.g. 2025-12-31.</summary>
    public string BaselineDate { get; set; } = string.Empty;

    /// <summary>
    /// Flattened counts: index = ageGroup * 2 + sexIndex (0=Male, 1=Female).
    /// Length = 24  (12 age groups × 2 sexes).
    /// Age group order: 0=&lt;1yr, 1=1-4, 2=5-9, 3=10-14, 4=15-19, 5=20-24,
    ///                  6=25-29, 7=30-34, 8=35-39, 9=40-44, 10=45-49, 11=50+
    /// </summary>
    public int[] Counts { get; set; } = new int[24];

    [JsonPropertyName("ctxTotalM")]
    public int    CTXTotalM       { get; set; }
    [JsonPropertyName("ctxTotalF")]
    public int    CTXTotalF       { get; set; }
    public int    DapsoneTotalM   { get; set; }
    public int    DapsoneTotalF   { get; set; }

    /// <summary>
    /// True when the facility has explicitly confirmed they had zero patients
    /// before the baseline date.  Suppresses "missing baseline" UI alerts.
    /// </summary>
    public bool   StartedFromZero { get; set; }

    public string? Notes { get; set; }
}

/// <summary>
/// Request body accepted by PUT /api/baseline/{facilityId}.
/// </summary>
public sealed class SaveBaselineRequest
{
    /// <summary>ISO date (yyyy-MM-dd) — last day of the baseline month.</summary>
    public string BaselineDate    { get; set; } = string.Empty;

    /// <summary>24 counts: ageGroup*2+sexIndex (0=Male,1=Female).</summary>
    public int[]  Counts          { get; set; } = new int[24];

    public int    CTXTotalM       { get; set; }
    public int    CTXTotalF       { get; set; }
    public int    DapsoneTotalM   { get; set; }
    public int    DapsoneTotalF   { get; set; }
    public bool   StartedFromZero { get; set; }
    public string? Notes          { get; set; }
}

/// <summary>
/// Warning item returned by GET /api/baseline/check.
/// </summary>
public sealed class BaselineWarning
{
    /// <summary>
    /// One of: "missing_baseline", "period_before_baseline", "outdated_baseline".
    /// </summary>
    public string Type                    { get; set; } = string.Empty;
    public int    FacilityId              { get; set; }
    public string FacilityName            { get; set; } = string.Empty;
    public string? BaselineDate           { get; set; }
    public int?   PatientsBeforeBaseline  { get; set; }
    public string Message                 { get; set; } = string.Empty;
}
