namespace PatientSyncApi.Models;

/// <summary>
/// Full sync payload sent from the PWA for the Unit TB Register.
/// Contains PtDetailsT records and their associated PtFollowUpT records.
/// </summary>
public sealed class TBFullSyncPayload
{
    public List<TBPatientRecord>  Patients  { get; set; } = new();
    public List<TBFollowUpRecord> FollowUps { get; set; } = new();
}

/// <summary>
/// Payload for syncing a monthly presumptive case tally.
/// </summary>
public sealed class TBPresumptiveSyncPayload
{
    public List<TBPresumptiveCaseRecord> Cases { get; set; } = new();
}

/// <summary>
/// A single monthly presumptive case count for one health facility.
/// Maps to the PresumptiveCaseT table.
/// </summary>
public sealed class TBPresumptiveCaseRecord
{
    public Guid   PresumptiveCaseTID { get; set; }
    public int    PresumptiveCase    { get; set; }
    public int    MonthID            { get; set; }
    public int    YearID             { get; set; }
    public int    NearestHFID        { get; set; }
    public int    DataSourceID       { get; set; }
    public int    HasChanged         { get; set; } = 1;
}
