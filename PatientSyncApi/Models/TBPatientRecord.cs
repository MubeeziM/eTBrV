namespace PatientSyncApi.Models;

/// <summary>
/// Represents a single Unit TB Register patient record in the PWA sync payload.
/// Maps to the PtDetailsT table in db_ac602a_v6nkwi3rvw.
/// </summary>
public sealed class TBPatientRecord
{
    // ── System / sync fields ──────────────────────────────────────────────
    public Guid   PtDetailsTID  { get; set; }
    public int    HasChanged    { get; set; } = 1;
    /// <summary>0 = active, 1 = soft-deleted. Propagated to the server on sync.</summary>
    public int    Deleted       { get; set; } = 0;

    /// <summary>
    /// The ID of the health facility selected from the tree at data-entry time.
    /// Stored in PtDetailsT.NearestHFID on the server.
    /// </summary>
    public int    NearestHFID   { get; set; }

    // ── Register column 1: Registration date ─────────────────────────────
    public DateTime? RegDate    { get; set; }

    // ── Register column 2: TB treatment register number ──────────────────
    public string?   UnitTBNo   { get; set; }

    // ── Register column 3: Patient name ──────────────────────────────────
    public string    PtName     { get; set; } = string.Empty;

    // ── Register column 4: Age ────────────────────────────────────────────
    public DateTime? DateOfBirth { get; set; }
    public int       Age         { get; set; }
    /// <summary>Months component for infants under 1 year. Null when not applicable.</summary>
    public int?      AgeMonths   { get; set; }

    // ── Register column 5: Sex ────────────────────────────────────────────
    public int    SexID          { get; set; }

    // ── Register column 6: Referred by ───────────────────────────────────
    public int    ReferredByID   { get; set; }

    // ── Register column 7: Physical address ──────────────────────────────
    public string? Village       { get; set; }
    public string? Boma          { get; set; }
    public string? Payam         { get; set; }
    public string? County        { get; set; }

    // ── Register column 8: Telephone ─────────────────────────────────────
    public string? PtPhone       { get; set; }

    // ── Register column 10: Site P / EP ──────────────────────────────────
    public int    TbTypeID       { get; set; }

    // ── Register column 11: Type of patient ──────────────────────────────
    public int    PtTypeID       { get; set; }
    /// <summary>Transfer-in source facility name (when PtTypeID = 5).</summary>
    public string? TIHF          { get; set; }
    /// <summary>Transfer-in source county name (when PtTypeID = 5).</summary>
    public string? TICounty      { get; set; }

    // ── Register column 12: Date treatment started ────────────────────────
    public DateTime? DateRxStarted { get; set; }

    // ── Register column 13: Treatment regimen ─────────────────────────────
    public int    RegimenID        { get; set; }

    // ── Register column 15: Method of diagnosis ───────────────────────────
    public int    DiagMethodID     { get; set; }

    // ── Administrative ────────────────────────────────────────────────────
    public int    CountryID        { get; set; } = 1;
}
