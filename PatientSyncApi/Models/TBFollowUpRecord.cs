namespace PatientSyncApi.Models;

/// <summary>
/// Represents a single Unit TB Register follow-up record in the PWA sync payload.
/// Maps to the PtFollowUpT table in db_ac602a_v6nkwi3rvw.
/// One record per patient — stores all sputum follow-up results, HIV/Xpert
/// at baseline, treatment outcome, ART/CPT activities, and remarks.
/// "Mon6" is the legacy name for the end-of-treatment smear examination.
/// </summary>
public sealed class TBFollowUpRecord
{
    // ── System / sync fields ──────────────────────────────────────────────
    public Guid   PtFollowUpTID  { get; set; }
    public Guid   PtDetailsTID   { get; set; }
    public int    HasChanged     { get; set; } = 1;
    public int    Deleted        { get; set; } = 0;

    // ── Register column 14: Before treatment ─────────────────────────────
    public DateTime? Mon0Date            { get; set; }
    public string?   Mon0LabNo           { get; set; }
    public int       Mon0LabResultID     { get; set; }
    public int       Mon0XpertResultID   { get; set; }
    public DateTime? Mon0XpertResultDate { get; set; }
    public DateTime? HIVTestDate         { get; set; }
    public int       HIVTestResultID     { get; set; }
    public string?   DSTResult           { get; set; }

    // ── Register columns 16–17: 2nd month follow-up ───────────────────────
    public DateTime? Mon2Date            { get; set; }
    public string?   Mon2LabNo           { get; set; }
    public int       Mon2LabResultID     { get; set; }

    // ── Register columns 18–19: 3rd month follow-up ───────────────────────
    public DateTime? Mon3Date            { get; set; }
    public string?   Mon3LabNo           { get; set; }
    public int       Mon3LabResultID     { get; set; }

    // ── Register columns 20–21: 5th month follow-up ───────────────────────
    public DateTime? Mon5Date            { get; set; }
    public string?   Mon5LabNo           { get; set; }
    public int       Mon5LabResultID     { get; set; }

    // ── Register columns 22–23: End of treatment ("Mon6" = legacy name) ───
    public DateTime? Mon6Date            { get; set; }
    public string?   Mon6LabNo           { get; set; }
    public int       Mon6LabResultID     { get; set; }

    // ── Register columns 24–29: Treatment outcome ─────────────────────────
    public int       OutcomeID           { get; set; }
    public DateTime? OutcomeDate         { get; set; }
    /// <summary>Transfer-out destination facility name.</summary>
    public string?   TOHF                { get; set; }
    /// <summary>Transfer-out destination county name.</summary>
    public string?   TOCounty            { get; set; }

    // ── Register column 30: ART ───────────────────────────────────────────
    public int       OnART               { get; set; }
    public DateTime? ARTDate             { get; set; }

    // ── Register column 31: CPT ───────────────────────────────────────────
    public int       OnCPT               { get; set; }
    public DateTime? CPTDate             { get; set; }

    // ── Register column 32: Moved to second-line ──────────────────────────
    public int       MovedTo2ndLine      { get; set; }

    // ── Register column 33: Remarks ───────────────────────────────────────
    public string?   Remarks             { get; set; }
}
