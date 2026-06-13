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
