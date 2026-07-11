using System.Collections.Concurrent;

namespace PatientSyncApi.Services;

/// <summary>
/// Thread-safe in-memory store for per-facility migration progress.
/// Registered as a singleton so progress survives individual HTTP requests
/// and can be polled while the background import task is running.
/// </summary>
public sealed class MigrationProgressService
{
    private readonly ConcurrentDictionary<int, MigrationProgressState> _state = new();

    /// <summary>
    /// Serializes full migrations and delta syncs to prevent SQL Server deadlocks.
    /// Only one operation runs at a time; additional requests wait in order.
    /// </summary>
    public SemaphoreSlim MigrationLock { get; } = new SemaphoreSlim(1, 1);

    public MigrationProgressState Get(int dataSourceId)
        => _state.GetOrAdd(dataSourceId, id => new MigrationProgressState { DataSourceId = id });

    public void Update(int dataSourceId, Action<MigrationProgressState> mutate)
    {
        var s = _state.GetOrAdd(dataSourceId, id => new MigrationProgressState { DataSourceId = id });
        lock (s) mutate(s);
    }
}

public sealed class MigrationProgressState
{
    public int    DataSourceId      { get; set; }
    /// <summary>idle | queued | running | delta-running | done | delta-done | error</summary>
    public string Status            { get; set; } = "idle";
    public int    TotalPatients     { get; set; }
    public int    ImportedPatients  { get; set; }
    public int    ImportedFollowUps { get; set; }
    public string Message           { get; set; } = string.Empty;
    /// <summary>0–100 percent based on patients processed.</summary>
    public int    Pct               => TotalPatients > 0
                                        ? (int)(ImportedPatients * 100.0 / TotalPatients)
                                        : 0;
}
