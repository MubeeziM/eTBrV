namespace PatientSyncApi.Models;

// ─────────────────────────────────────────────────────────────────────────────
//  Request / Response DTOs for AuthController
// ─────────────────────────────────────────────────────────────────────────────

/// <summary>Self-registration payload.</summary>
public sealed class RegisterRequest
{
    public string  FullName     { get; set; } = string.Empty;
    /// <summary>Used to log in. Must be unique across the system.</summary>
    public string  UserName     { get; set; } = string.Empty;
    public string  Password     { get; set; } = string.Empty;
    public string  EmailAddress { get; set; } = string.Empty;
    public string? PhoneNo      { get; set; }

    /// <summary>
    /// Health facility where the user is based.
    /// Matches HealthFacilityT.HealthFacilityID. 0 = not facility-based.
    /// Also stored in UserT.DataSourceID for data-access scoping.
    /// </summary>
    public int     HealthFacilityID { get; set; }

    /// <summary>
    /// 1 = Data Entrant, 2 = County Supervisor,
    /// 3 = State Coordinator, 4 = National.
    /// Defaults to 1 (Data Entrant) for self-registration.
    /// </summary>
    public int     GroupID      { get; set; } = 1;

    /// <summary>County scope — required for GroupID 2 (County Supervisor).</summary>
    public int     CountyID     { get; set; }

    /// <summary>State scope.</summary>
    public int     StateID      { get; set; }

    /// <summary>NGO regional office / field location ID — for NGO/Sub-Recipient users.</summary>
    public int     LocationID   { get; set; }

    /// <summary>Sub-Recipient partner ID (SubRecT.SubRecID). 0 = not NGO-affiliated.</summary>
    public int     SubRecID     { get; set; }
}

/// <summary>Payload for PUT /api/auth/users/{userTID}/facilities.</summary>
public sealed class UserFacilitiesRequest
{
    /// <summary>
    /// Explicit list of HealthFacilityIDs to assign.
    /// An empty list clears all assignments (reverts to default scope).
    /// </summary>
    public List<int> FacilityIds { get; set; } = new();
}

/// <summary>Login payload.</summary>
public sealed class LoginRequest
{
    public string UserName { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
}

/// <summary>Successful login response — contains the JWT and full session profile.</summary>
public sealed class LoginResponse
{
    public string       Token        { get; set; } = string.Empty;
    public DateTime     ExpiresAt    { get; set; }
    // Identity
    public int          UserID       { get; set; }
    public string       UserTID      { get; set; } = string.Empty;
    public string       UserName     { get; set; } = string.Empty;
    public string       FullName     { get; set; } = string.Empty;
    public string       EmailAddress { get; set; } = string.Empty;
    // Geography / scope
    public int          DataSourceID { get; set; }
    public int          GroupID      { get; set; }
    public int          CountyID     { get; set; }
    public int          StateID      { get; set; }
    public int          CountryID    { get; set; }
    public int          LocationID   { get; set; }
    public int          SubRecID     { get; set; }
    // Role flags
    public bool         Dtls         { get; set; }
    public bool         Zonal        { get; set; }
    public bool         Ntp          { get; set; }
    public bool         Ngo          { get; set; }
    public int          AdminID      { get; set; }
    public int          SuperUserID  { get; set; }
    /// <summary>All role names encoded in the token (e.g. "DataEntrant", "Admin").</summary>
    public List<string> Roles        { get; set; } = new();
    /// <summary>NGO/Sub-Recipient partner name from SubRecT.SubRec. Empty if user is not NGO-affiliated.</summary>
    public string       NgoName      { get; set; } = string.Empty;
    /// <summary>Profile picture as a data-URI (e.g. "data:image/jpeg;base64,…"). Null if no avatar is set.</summary>
    public string?      AvatarBase64 { get; set; }
}

/// <summary>Initiates a forgot-password flow — caller supplies their email address.</summary>
public sealed class ForgotPasswordRequest
{
    public string EmailAddress { get; set; } = string.Empty;
}

/// <summary>Completes a forgot-password flow — caller supplies the one-time code.</summary>
public sealed class ResetPasswordRequest
{
    public string UserName    { get; set; } = string.Empty;
    public string ResetCode   { get; set; } = string.Empty;
    public string NewPassword { get; set; } = string.Empty;
}

/// <summary>
/// Profile fields that a logged-in user may update on their own account.
/// All fields are optional — only non-null / non-empty values are applied.
/// Facility assignments are intentionally excluded; those are admin-controlled.
/// </summary>
public sealed class UpdateProfileRequest
{
    public string? FullName     { get; set; }
    public string? UserName     { get; set; }
    public string? EmailAddress { get; set; }
    public string? PhoneNo      { get; set; }
    /// <summary>
    /// Data-URI of the profile picture (e.g. "data:image/jpeg;base64,…").
    /// Pass an empty string to clear the avatar.
    /// Max decoded size enforced server-side: 200 KB.
    /// </summary>
    public string? AvatarBase64 { get; set; }
}

/// <summary>Payload returned after a successful profile update — mirrors the fields that changed.</summary>
public sealed class UpdateProfileResponse
{
    public string  FullName     { get; set; } = string.Empty;
    public string  UserName     { get; set; } = string.Empty;
    public string  EmailAddress { get; set; } = string.Empty;
    public string? PhoneNo      { get; set; }
    public string? AvatarBase64 { get; set; }
    /// <summary>Fresh JWT that reflects the updated FullName / UserName claims.</summary>
    public string  Token        { get; set; } = string.Empty;
    public DateTime ExpiresAt   { get; set; }
}

/// <summary>Allows a logged-in user to change their own password. Requires the current password for verification.</summary>
public sealed class ChangePasswordRequest
{
    public string CurrentPassword { get; set; } = string.Empty;
    public string NewPassword     { get; set; } = string.Empty;
}

/// <summary>
/// All per-user configurable preferences.
/// Returned by GET /api/auth/preferences and accepted by PUT /api/auth/preferences.
/// Every field has a safe default so missing rows in UserPreferencesT are harmless.
/// </summary>
public sealed class UserPreferencesDto
{
    // ── Clinical Thresholds ───────────────────────────────────────────────
    public int  TbLookbackDays          { get; set; } = 365;
    public int  OutcomeEligNewMin       { get; set; } = 168;
    public int  OutcomeEligNewMax       { get; set; } = 270;
    public int  OutcomeEligReTxMin      { get; set; } = 224;
    public int  OutcomeEligReTxMax      { get; set; } = 320;
    public int  DqNoOutcomeNewMin       { get; set; } = 180;
    public int  DqNoOutcomeNewMax       { get; set; } = 540;
    public int  DqNoOutcomeReTxMin      { get; set; } = 240;
    public int  DqNoOutcomeReTxMax      { get; set; } = 600;
    public int  DqDiagMethodDays        { get; set; } = 180;
    // ── Data Entry ────────────────────────────────────────────────────────
    public int  ArtLoadLimit            { get; set; } = 0;
    public bool DupNameCheckEnabled     { get; set; } = true;
    // ── Monitoring ────────────────────────────────────────────────────────
    public string DefaultMonMode        { get; set; } = "missed";
    public int  MonRowsPerPage          { get; set; } = 500;
    // ── Reports ───────────────────────────────────────────────────────────
    public string DefaultReportPeriodType { get; set; } = "monthly";
    public int  DefaultReportFacilityID { get; set; } = 0;
    // ── Session & Security ────────────────────────────────────────────────
    public int  InactivityWarnMinutes   { get; set; } = 13;
    public int  AutoLogoutMinutes       { get; set; } = 2;
    public int  SyncIntervalMinutes     { get; set; } = 5;
    // ── Display & Usability ───────────────────────────────────────────────
    public int  NameTruncLength         { get; set; } = 15;
    public bool ShowTbSection           { get; set; } = true;
    public bool ShowDqSection           { get; set; } = true;
    public bool PinEnrollDismissed      { get; set; } = false;
    public bool DqAutoClose             { get; set; } = false;
    public bool CompactTableMode        { get; set; } = false;
}
