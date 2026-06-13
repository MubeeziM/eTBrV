using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace PatientSyncApi.Services;

/// <summary>
/// Generates signed JWT tokens for authenticated users.
///
/// SECURITY NOTES:
///   - Tokens are signed with HMAC-SHA256. The signing key must be at least
///     32 bytes (256 bits) and kept secret — treat it like a password.
///   - ClockSkew is set to zero so tokens expire exactly at ExpiresAt
///     with no silent grace period.
///   - Role claims allow PatientsController to enforce data-scoping without
///     an extra database round-trip on every request.
/// </summary>
public sealed class TokenService
{
    private readonly IConfiguration _config;

    public TokenService(IConfiguration config) => _config = config;

    public string GenerateToken(UserTokenData data)
    {
        var keyBytes = Encoding.UTF8.GetBytes(
            _config["Jwt:Key"]
            ?? throw new InvalidOperationException("Jwt:Key is not configured."));

        var creds = new SigningCredentials(
            new SymmetricSecurityKey(keyBytes),
            SecurityAlgorithms.HmacSha256);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub,   data.UserTID),
            new(JwtRegisteredClaimNames.Name,  data.FullName),
            new(JwtRegisteredClaimNames.Email, data.EmailAddress ?? string.Empty),
            new(JwtRegisteredClaimNames.Jti,   Guid.NewGuid().ToString()),

            // Identity
            new("user_id",       data.UserID.ToString()),
            new("username",      data.UserName),

            // Geographic / facility scope claims — used by controllers to
            // filter records without an extra DB query per request.
            new("facility_id",   data.DataSourceID.ToString()),
            new("group_id",      data.GroupID.ToString()),
            new("county_id",     data.CountyID.ToString()),
            new("state_id",      data.StateID.ToString()),
            new("country_id",    data.CountryID.ToString()),
            new("location_id",   data.LocationID.ToString()),
            new("sub_rec_id",    data.SubRecID.ToString()),

            // Admin / super-user flags kept as separate claims so middleware
            // can check them independently of the primary role.
            new("is_admin",       data.AdminID.ToString()),
            new("is_super_user",  data.SuperUserID.ToString()),
        };

        // ASP.NET Core collects every ClaimTypes.Role claim into User.IsInRole()
        // and into [Authorize(Roles = "...")] checks.
        foreach (var role in data.Roles)
            claims.Add(new Claim(ClaimTypes.Role, role));

        var expiryHours = _config.GetValue<int>("Jwt:ExpiryHours", 8);

        var token = new JwtSecurityToken(
            issuer:             _config["Jwt:Issuer"],
            audience:           _config["Jwt:Audience"],
            claims:             claims,
            expires:            DateTime.UtcNow.AddHours(expiryHours),
            signingCredentials: creds);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}

/// <summary>Data bag passed to <see cref="TokenService.GenerateToken"/>.</summary>
public sealed class UserTokenData
{
    public int          UserID       { get; init; }
    public string       UserTID      { get; init; } = string.Empty;
    public string       UserName     { get; init; } = string.Empty;
    public string       FullName     { get; init; } = string.Empty;
    public string?      EmailAddress { get; init; }
    public int          DataSourceID { get; init; }
    public int          GroupID      { get; init; }
    public int          CountyID     { get; init; }
    public int          StateID      { get; init; }
    public int          CountryID    { get; init; }
    public int          LocationID   { get; init; }
    public int          SubRecID     { get; init; }
    public int          AdminID      { get; init; }
    public int          SuperUserID  { get; init; }
    public List<string> Roles        { get; init; } = new();
}
