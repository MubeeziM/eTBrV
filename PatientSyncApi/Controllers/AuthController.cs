using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using PatientSyncApi.Models;
using PatientSyncApi.Services;

namespace PatientSyncApi.Controllers;

/// <summary>
/// Handles user registration, login, password reset and account approval.
///
/// SECURITY:
///   - Passwords are hashed with BCrypt (work factor 12) â€” never stored as
///     plaintext or reversible encoding.
///   - Forgot-password codes are BCrypt-hashed before storage so a DB read
///     alone cannot be used to reset an account.
///   - Timing-safe dummy BCrypt check on login prevents user-enumeration via
///     response time differences.
///   - Account-existence is not revealed in forgot-password responses
///     (always returns the same message â€” OWASP A07:2021).
///   - All SQL uses parameterised queries (OWASP A03:2021).
/// </summary>
[ApiController]
[Route("api/auth")]
public sealed class AuthController : ControllerBase
{
    // Dummy hash used during the timing-safe login check when a user is not found.
    // This ensures the BCrypt.Verify call always happens, so response time does
    // not leak whether the username exists.
    private const string DummyHash =
        "$2a$12$dummyhashfortimingprotectionXXXXXXXXXXXXXXXXXXXXXXXXXX";

    private readonly string                    _connectionString;
    private readonly TokenService              _tokenService;
    private readonly EmailService              _emailService;
    private readonly IConfiguration            _config;
    private readonly ILogger<AuthController>   _logger;

    public AuthController(
        IConfiguration config,
        TokenService tokenService,
        EmailService emailService,
        ILogger<AuthController> logger)
    {
        _connectionString = config.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("DefaultConnection is not configured.");
        _tokenService = tokenService;
        _emailService = emailService;
        _config       = config;
        _logger       = logger;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  GET /api/auth/check-username?username=x
    //  Returns 200 { available: true } or 200 { available: false }.
    //  Used by the registration form to give real-time feedback before submit.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    [HttpGet("check-username")]
    public async Task<IActionResult> CheckUsername([FromQuery] string username)
    {
        if (string.IsNullOrWhiteSpace(username))
            return Ok(new { available = false });

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();
        await using var cmd = new SqlCommand(
            "SELECT COUNT(1) FROM UserT WHERE UserName = @UserName AND Deleted = 0",
            conn);
        cmd.Parameters.AddWithValue("@UserName", username.Trim());
        var count = (int)(await cmd.ExecuteScalarAsync() ?? 0);
        return Ok(new { available = count == 0 });
    }

    [HttpGet("check-email")]
    public async Task<IActionResult> CheckEmail([FromQuery] string email)
    {
        if (string.IsNullOrWhiteSpace(email))
            return Ok(new { available = false });

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();
        await using var cmd = new SqlCommand(
            "SELECT COUNT(1) FROM UserT WHERE EmailAddress = @Email AND Deleted = 0",
            conn);
        cmd.Parameters.AddWithValue("@Email", email.Trim());
        var count = (int)(await cmd.ExecuteScalarAsync() ?? 0);
        return Ok(new { available = count == 0 });
    }

    [HttpGet("check-phone")]
    public async Task<IActionResult> CheckPhone([FromQuery] string phone)
    {
        if (string.IsNullOrWhiteSpace(phone))
            return Ok(new { available = false, partial = false });

        var val = phone.Trim();
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        if (val.Length == 10)
        {
            // Exact match for complete number
            await using var cmd = new SqlCommand(
                "SELECT COUNT(1) FROM UserT WHERE PhoneNo = @Phone AND Deleted = 0", conn);
            cmd.Parameters.AddWithValue("@Phone", val);
            var count = (int)(await cmd.ExecuteScalarAsync() ?? 0);
            return Ok(new { available = count == 0, partial = false });
        }
        else
        {
            // Starts-with match for partial input (early warning)
            await using var cmd = new SqlCommand(
                "SELECT COUNT(1) FROM UserT WHERE PhoneNo LIKE @Phone AND Deleted = 0", conn);
            cmd.Parameters.AddWithValue("@Phone", val + "%");
            var count = (int)(await cmd.ExecuteScalarAsync() ?? 0);
            return Ok(new { available = count == 0, partial = true });
        }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  POST /api/auth/register
    //  Creates a new user account with ApprovedID = 0 (pending approval).
    //  The account cannot be used until an Admin or SuperUser approves it.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // ---------------------------------------------------------------------------
    //  POST /api/auth/register
    //  Creates a new user account with ApprovedID = 0 (pending approval).
    //  The account cannot be used until an Admin or SuperUser approves it.
    // ---------------------------------------------------------------------------
    [HttpPost("register")]
    public async Task<IActionResult> Register([FromBody] RegisterRequest req)
    {
        // -- Input validation --
        if (string.IsNullOrWhiteSpace(req.FullName))
            return BadRequest(new { error = "FullName is required." });

        if (string.IsNullOrWhiteSpace(req.UserName))
            return BadRequest(new { error = "UserName is required." });

        if (string.IsNullOrWhiteSpace(req.EmailAddress))
            return BadRequest(new { error = "EmailAddress is required." });

        if (string.IsNullOrWhiteSpace(req.Password) || req.Password.Length < 8)
            return BadRequest(new { error = "Password must be at least 8 characters." });

        // Infer GroupID: county or facility selected -> 2 (County level), else 4 (National/NGO)
        int inferredGroupID = (req.HealthFacilityID > 0 || req.CountyID > 0) ? 2 : 4;

        // DataSourceID mirrors HealthFacilityID for data-access filtering.
        int dataSourceID = req.HealthFacilityID > 0 ? req.HealthFacilityID : 0;
        var userTID = Guid.NewGuid().ToString();
        var pwdHash = BCrypt.Net.BCrypt.HashPassword(req.Password, workFactor: 12);

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var tx = (SqlTransaction)await conn.BeginTransactionAsync();

            // Check for duplicate UserName or EmailAddress in a single query.
            await using var checkCmd = new SqlCommand(
                """
                SELECT COUNT(1) FROM UserT
                WHERE (UserName = @UserName OR EmailAddress = @EmailAddress)
                  AND Deleted = 0
                """, conn, tx);
            checkCmd.Parameters.AddWithValue("@UserName",     req.UserName.Trim());
            checkCmd.Parameters.AddWithValue("@EmailAddress", req.EmailAddress.Trim());

            var existingCount = (int)(await checkCmd.ExecuteScalarAsync() ?? 0);
            if (existingCount > 0)
                return Conflict(new { error = "UserName or EmailAddress is already in use." });

            // Insert into UserT
            await using var insertUser = new SqlCommand(
                """
                INSERT INTO UserT
                    (FullName, UserName, PwdHash, DataSourceID, PhoneNo, EmailAddress,
                     ApprovedID, HasChanged, Deleted, LastUpdated, CreatedAt, UserTID)
                VALUES
                    (@FullName, @UserName, @PwdHash, @DataSourceID, @PhoneNo, @EmailAddress,
                     0, 0, 0, GETDATE(), GETDATE(), @UserTID)
                """, conn, tx);
            insertUser.Parameters.AddWithValue("@FullName",     req.FullName.Trim());
            insertUser.Parameters.AddWithValue("@UserName",     req.UserName.Trim());
            insertUser.Parameters.AddWithValue("@PwdHash",      pwdHash);
            insertUser.Parameters.AddWithValue("@DataSourceID", dataSourceID);
            insertUser.Parameters.AddWithValue("@PhoneNo",      (object?)req.PhoneNo?.Trim() ?? DBNull.Value);
            insertUser.Parameters.AddWithValue("@EmailAddress", req.EmailAddress.Trim());
            insertUser.Parameters.AddWithValue("@UserTID",      userTID);
            await insertUser.ExecuteNonQueryAsync();

            // Insert into CrossRefGpUsersT
            // GroupID inferred from geography; NGO flag driven by SubRecID.
            bool isNGO = req.SubRecID > 0;
            await using var insertCross = new SqlCommand(
                """
                INSERT INTO CrossRefGpUsersT
                    (UserTID, GroupID, CountyID, StateID, LocationID,
                     DTLS, Zonal, NTP, NGO, SubRecID,
                     HasChanged, CountryID, DistrictID, AdminID, SuperUserID)
                VALUES
                    (@UserTID, @GroupID, @CountyID, @StateID, @LocationID,
                     @DTLS, 0, @NTP, @NGO, @SubRecID,
                     0, 0, 0, 0, 0)
                """, conn, tx);
            insertCross.Parameters.AddWithValue("@UserTID",    userTID);
            insertCross.Parameters.AddWithValue("@GroupID",    inferredGroupID);
            insertCross.Parameters.AddWithValue("@CountyID",   req.CountyID);
            insertCross.Parameters.AddWithValue("@StateID",    req.StateID);
            insertCross.Parameters.AddWithValue("@LocationID", req.LocationID);
            insertCross.Parameters.AddWithValue("@DTLS",       inferredGroupID == 2 ? 1 : 0);
            insertCross.Parameters.AddWithValue("@NTP",        inferredGroupID == 4 ? 1 : 0);
            insertCross.Parameters.AddWithValue("@NGO",        isNGO ? 1 : 0);
            insertCross.Parameters.AddWithValue("@SubRecID",   req.SubRecID);
            await insertCross.ExecuteNonQueryAsync();

            await tx.CommitAsync();

            _logger.LogInformation("New user registered: {UserTID}, GroupID={GroupID}", userTID, inferredGroupID);

            return CreatedAtAction(nameof(Register), new
            {
                message = "Account created. An administrator will review and approve your account before you can log in.",
                userTID
            });
        }
        catch (SqlException ex) when (ex.Number is 2627 or 2601)
        {
            // Unique constraint violation -- race condition between check and insert.
            return Conflict(new { error = "UserName or EmailAddress is already in use." });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during user registration.");
            return StatusCode(500, new { error = "Registration failed. Please try again later." });
        }
    }

    // ---------------------------------------------------------------------------
    //  GET /api/auth/states
    //  Returns the state list for the cascading location dropdowns.
    //  No authentication required (used on the public registration form).
    // ---------------------------------------------------------------------------
    [HttpGet("states")]
    public async Task<IActionResult> GetStates()
    {
        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var cmd = new SqlCommand(
                """
                SELECT 0 AS StateID, ' ALL States' AS State FROM StateT
                UNION
                SELECT StateID, State FROM StateT WHERE StateID NOT IN(11, 12)
                ORDER BY State
                """, conn);
            var results = new List<object>();
            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
                results.Add(new { stateID = reader.GetInt32(0), state = reader.GetString(1).Trim() });
            return Ok(results);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error loading states.");
            return StatusCode(500, new { error = "Could not load states." });
        }
    }
    // ─────────────────────────────────────────────────────────────────────────
    //  GET /api/auth/counties?stateId=X
    // ─────────────────────────────────────────────────────────────────────────
    [HttpGet("counties")]
    public async Task<IActionResult> GetCounties([FromQuery] int stateId)
    {
        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var cmd = new SqlCommand(
                """
                SELECT 0 AS CountyID, ' ALL Counties' AS County FROM CountyT
                UNION
                SELECT CountyID, County FROM CountyT WHERE StateID = @StateID
                ORDER BY County
                """, conn);
            cmd.Parameters.AddWithValue("@StateID", stateId);
            var results = new List<object>();
            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
                results.Add(new { countyID = reader.GetInt32(0), county = reader.GetString(1).Trim() });
            return Ok(results);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error loading counties for state {StateId}.", stateId);
            return StatusCode(500, new { error = "Could not load counties." });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GET /api/auth/facilities?countyId=X
    // ─────────────────────────────────────────────────────────────────────────
    [HttpGet("facilities")]
    public async Task<IActionResult> GetFacilities([FromQuery] int countyId)
    {
        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var cmd = new SqlCommand(
                """
                SELECT 0 AS HealthFacilityID, ' ALL Facilities' AS HealthFacility FROM HealthFacilityT
                UNION
                SELECT HealthFacilityID, HealthFacility FROM HealthFacilityT WHERE CountyID = @CountyID
                ORDER BY HealthFacility
                """, conn);
            cmd.Parameters.AddWithValue("@CountyID", countyId);
            var results = new List<object>();
            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
                results.Add(new { healthFacilityID = reader.GetInt32(0), healthFacility = reader.GetString(1).Trim() });
            return Ok(results);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error loading facilities for county {CountyId}.", countyId);
            return StatusCode(500, new { error = "Could not load facilities." });
        }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  POST /api/auth/login
    //  Validates credentials and returns a signed JWT on success.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    [HttpPost("login")]
    public async Task<IActionResult> Login([FromBody] LoginRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.UserName) || string.IsNullOrWhiteSpace(req.Password))
            return BadRequest(new { error = "UserName and Password are required." });

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // Load the user + their cross-ref row in one query.
            await using var cmd = new SqlCommand(
                """
                SELECT UserID, UserName, FullName, UserTID, EmailAddress, PwdHash,
                       DataSourceID, ApprovedID, CountryID, GroupID,
                       CountyID, StateID, LocationID,
                       DTLS, Zonal, NTP, NGO, SubRecID,
                       AdminID, SuperUserID
                FROM vwUserQ
                WHERE (UserName = @Login OR EmailAddress = @Login)
                  AND Deleted = 0
                """, conn);
            cmd.Parameters.AddWithValue("@Login", req.UserName.Trim());

            await using var reader = await cmd.ExecuteReaderAsync();

            if (!await reader.ReadAsync())
            {
                // User not found â€” still do a BCrypt check to keep response time
                // identical to a found-but-wrong-password case (timing-safe).
                BCrypt.Net.BCrypt.Verify(req.Password, DummyHash);
                return Unauthorized(new { error = "Invalid credentials." });
            }

            var pwdHash    = reader["PwdHash"]?.ToString();
            var approvedID = Convert.ToInt32(reader["ApprovedID"]);

            // Verify password BEFORE revealing approval status so an attacker
            // cannot enumerate valid usernames by looking for the approval message.
            if (string.IsNullOrEmpty(pwdHash) || !BCrypt.Net.BCrypt.Verify(req.Password, pwdHash))
                return Unauthorized(new { error = "Invalid credentials." });

            if (approvedID != 1)
                return Unauthorized(new { error = "Your account is pending approval. Please contact your administrator." });

            // â”€â”€ Build role list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            bool dtls       = reader["DTLS"]       != DBNull.Value && Convert.ToBoolean(reader["DTLS"]);
            bool zonal      = reader["Zonal"]      != DBNull.Value && Convert.ToBoolean(reader["Zonal"]);
            bool ntp        = reader["NTP"]        != DBNull.Value && Convert.ToBoolean(reader["NTP"]);
            bool ngo        = reader["NGO"]        != DBNull.Value && Convert.ToBoolean(reader["NGO"]);
            int  adminID    = reader["AdminID"]    == DBNull.Value ? 0 : Convert.ToInt32(reader["AdminID"]);
            int  superUser  = reader["SuperUserID"] == DBNull.Value ? 0 : Convert.ToInt32(reader["SuperUserID"]);

            var roles = new List<string>();
            if (superUser == 1) roles.Add("SuperUser");
            if (adminID   == 1) roles.Add("Admin");
            if (ntp)            roles.Add("National");
            if (zonal)          roles.Add("StateCoordinator");
            if (dtls)           roles.Add("CountySupervisor");
            if (ngo)            roles.Add("NGO");
            if (roles.Count == 0 || (!ntp && !zonal && !dtls && !ngo))
                roles.Add("DataEntrant");

            var tokenData = new UserTokenData
            {
                UserID       = reader["UserID"]       == DBNull.Value ? 0 : Convert.ToInt32(reader["UserID"]),
                UserTID      = reader["UserTID"].ToString()!,
                UserName     = reader["UserName"]?.ToString() ?? string.Empty,
                FullName     = reader["FullName"]?.ToString() ?? string.Empty,
                EmailAddress = reader["EmailAddress"]?.ToString(),
                DataSourceID = reader["DataSourceID"] == DBNull.Value ? 0 : Convert.ToInt32(reader["DataSourceID"]),
                GroupID      = reader["GroupID"]      == DBNull.Value ? 0 : Convert.ToInt32(reader["GroupID"]),
                CountyID     = reader["CountyID"]     == DBNull.Value ? 0 : Convert.ToInt32(reader["CountyID"]),
                StateID      = reader["StateID"]      == DBNull.Value ? 0 : Convert.ToInt32(reader["StateID"]),
                CountryID    = reader["CountryID"]    == DBNull.Value ? 0 : Convert.ToInt32(reader["CountryID"]),
                LocationID   = reader["LocationID"]   == DBNull.Value ? 0 : Convert.ToInt32(reader["LocationID"]),
                SubRecID     = reader["SubRecID"]     == DBNull.Value ? 0 : Convert.ToInt32(reader["SubRecID"]),
                AdminID      = adminID,
                SuperUserID  = superUser,
                Roles        = roles
            };

            var token       = _tokenService.GenerateToken(tokenData);
            var expiryHours = _config.GetValue<int>("Jwt:ExpiryHours", 8);

            _logger.LogInformation("User logged in: {UserTID}", tokenData.UserTID);

            return Ok(new LoginResponse
            {
                Token        = token,
                ExpiresAt    = DateTime.UtcNow.AddHours(expiryHours),
                UserID       = tokenData.UserID,
                UserTID      = tokenData.UserTID,
                UserName     = tokenData.UserName,
                FullName     = tokenData.FullName,
                EmailAddress = tokenData.EmailAddress ?? string.Empty,
                DataSourceID = tokenData.DataSourceID,
                GroupID      = tokenData.GroupID,
                CountyID     = tokenData.CountyID,
                StateID      = tokenData.StateID,
                CountryID    = tokenData.CountryID,
                LocationID   = tokenData.LocationID,
                SubRecID     = tokenData.SubRecID,
                Dtls         = dtls,
                Zonal        = zonal,
                Ntp          = ntp,
                Ngo          = ngo,
                AdminID      = adminID,
                SuperUserID  = superUser,
                Roles        = roles
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during login.");
            return StatusCode(500, new { error = "Login failed. Please try again later." });
        }
    }


    // ----------------------------------------------------------------------------
    //  GET /api/auth/subrecipients
    //  Returns NGO sub-recipient partners for the registration cascade.
    //  No authentication required (used on the public registration form).
    // ----------------------------------------------------------------------------
    [HttpGet("subrecipients")]
    public async Task<IActionResult> GetSubRecipients()
    {
        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var cmd = new SqlCommand(
                """
                SELECT 0 AS SubRecID, ' Select One' AS SubRec FROM SubRecT
                UNION
                SELECT SubRecID, SubRec FROM SubRecT WHERE SubRecID IN (2, 14)
                ORDER BY SubRec
                """, conn);
            var results = new List<object>();
            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
                results.Add(new { subRecID = reader.GetInt32(0), subRec = reader.GetString(1).Trim() });
            return Ok(results);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error loading sub-recipients.");
            return StatusCode(500, new { error = "Could not load sub-recipients." });
        }
    }

    // ----------------------------------------------------------------------------
    //  GET /api/auth/locations?subRecId=X
    //  Returns NGO field locations for the selected sub-recipient.
    //  No authentication required (used on the public registration form).
    // ----------------------------------------------------------------------------
    [HttpGet("locations")]
    public async Task<IActionResult> GetNGOLocations([FromQuery] int subRecId)
    {
        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var cmd = new SqlCommand(
                """
                SELECT 0 AS LocationID, ' ALL Field Locations' AS Location FROM LocationT
                UNION
                SELECT LocationID, Location FROM LocationT WHERE SubRecID = @SubRecID AND LocationID NOT IN (16, 17)
                ORDER BY Location
                """, conn);
            cmd.Parameters.AddWithValue("@SubRecID", subRecId);
            var results = new List<object>();
            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
                results.Add(new { locationID = reader.GetInt32(0), location = reader.GetString(1).Trim() });
            return Ok(results);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error loading NGO locations for sub-recipient {SubRecId}.", subRecId);
            return StatusCode(500, new { error = "Could not load field locations." });
        }
    }
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  POST /api/auth/forgot-password
    //  Generates a 6-digit one-time reset code valid for 30 minutes.
    //
    //  SECURITY: The response is always identical whether or not the email
    //  exists. This prevents email-enumeration attacks (OWASP A07).
    //
    //  TODO: Replace the in-response code with an email / SMS delivery service
    //        before going to production. The "resetCode" field in the response
    //        is only present so you can test without an email server.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    [HttpPost("forgot-password")]
    public async Task<IActionResult> ForgotPassword([FromBody] ForgotPasswordRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.EmailAddress))
            return BadRequest(new { error = "EmailAddress is required." });

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            await using var cmd = new SqlCommand(
                "SELECT UserTID FROM UserT WHERE EmailAddress = @EmailAddress AND Deleted = 0",
                conn);
            cmd.Parameters.AddWithValue("@EmailAddress", req.EmailAddress.Trim());
            var userTID = await cmd.ExecuteScalarAsync() as string;

            // Always return this message regardless of whether the email is found.
            const string safeMsg = "If that email address is registered, a reset code has been generated.";

            if (userTID == null)
                return Ok(new { message = safeMsg });

            // 6-digit code â€” sufficient entropy for a 30-minute window.
            var code     = Random.Shared.Next(100_000, 1_000_000).ToString();
            // Lower work factor (10) is acceptable here because the code expires
            // in 30 minutes and is 6 digits â€” BCrypt is just preventing a DB read
            // from directly yielding a usable reset token.
            var codeHash = BCrypt.Net.BCrypt.HashPassword(code, workFactor: 10);
            var expiry   = DateTime.UtcNow.AddMinutes(30);

            await using var update = new SqlCommand(
                """
                UPDATE UserT
                SET FgtPwdCodeHash = @Hash,
                    FgtPwdExpiry   = @Expiry,
                    HasChanged     = 1,
                    LastUpdated    = GETDATE()
                WHERE UserTID = @UserTID
                """, conn);
            update.Parameters.AddWithValue("@Hash",   codeHash);
            update.Parameters.AddWithValue("@Expiry", expiry);
            update.Parameters.AddWithValue("@UserTID", userTID);
            await update.ExecuteNonQueryAsync();

            _logger.LogInformation(
                "Password reset code generated for {UserTID}. Expiry: {Expiry}", userTID, expiry);

            var sendTo = req.EmailAddress.Trim();
            _logger.LogInformation("Attempting reset email to: [{EmailAddress}]", sendTo);
            var emailSent = await _emailService.SendPasswordResetCodeAsync(sendTo, code);
            _logger.LogInformation("Reset email result for [{EmailAddress}]: {Result}", sendTo, emailSent ? "sent" : "FAILED");

            return Ok(new { message = safeMsg });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during forgot-password.");
            return StatusCode(500, new { error = "An error occurred. Please try again later." });
        }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  POST /api/auth/reset-password
    //  Validates the one-time code and updates the password hash.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    [HttpPost("reset-password")]
    public async Task<IActionResult> ResetPassword([FromBody] ResetPasswordRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.UserName)  ||
            string.IsNullOrWhiteSpace(req.ResetCode) ||
            string.IsNullOrWhiteSpace(req.NewPassword))
            return BadRequest(new { error = "UserName, ResetCode, and NewPassword are required." });

        if (req.NewPassword.Length < 8)
            return BadRequest(new { error = "Password must be at least 8 characters." });

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            await using var cmd = new SqlCommand(
                """
                SELECT UserTID, FgtPwdCodeHash, FgtPwdExpiry
                FROM UserT
                WHERE UserName = @UserName AND Deleted = 0
                """, conn);
            cmd.Parameters.AddWithValue("@UserName", req.UserName.Trim());

            await using var reader = await cmd.ExecuteReaderAsync();
            if (!await reader.ReadAsync())
                return BadRequest(new { error = "Invalid reset request." });

            var userTID  = reader["UserTID"].ToString()!;
            var codeHash = reader["FgtPwdCodeHash"]?.ToString();
            var expiry   = reader["FgtPwdExpiry"] == DBNull.Value
                ? (DateTime?)null
                : Convert.ToDateTime(reader["FgtPwdExpiry"]);

            await reader.CloseAsync();

            if (string.IsNullOrEmpty(codeHash) || expiry is null)
                return BadRequest(new { error = "No active reset request found. Please request a new reset code." });

            if (DateTime.UtcNow > expiry)
                return BadRequest(new { error = "Reset code has expired. Please request a new one." });

            if (!BCrypt.Net.BCrypt.Verify(req.ResetCode, codeHash))
                return BadRequest(new { error = "Invalid reset code." });

            var newHash = BCrypt.Net.BCrypt.HashPassword(req.NewPassword, workFactor: 12);

            await using var update = new SqlCommand(
                """
                UPDATE UserT
                SET PwdHash        = @PwdHash,
                    FgtPwdCodeHash = NULL,
                    FgtPwdExpiry   = NULL,
                    HasChanged     = 1,
                    LastUpdated    = GETDATE()
                WHERE UserTID = @UserTID
                """, conn);
            update.Parameters.AddWithValue("@PwdHash",  newHash);
            update.Parameters.AddWithValue("@UserTID",  userTID);
            await update.ExecuteNonQueryAsync();

            _logger.LogInformation("Password reset completed for {UserTID}.", userTID);
            return Ok(new { message = "Password reset successful. You can now log in." });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during reset-password.");
            return StatusCode(500, new { error = "An error occurred. Please try again later." });
        }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  POST /api/auth/approve/{userTID}
    //  Marks a pending account as approved. Requires Admin or SuperUser role.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    [HttpPost("approve/{userTID}")]
    [Authorize(Roles = "Admin,SuperUser")]
    public async Task<IActionResult> ApproveUser(string userTID)
    {
        // Extract the caller's UserTID from the JWT "sub" claim.
        var approverTID = User.FindFirstValue(ClaimTypes.NameIdentifier)
                       ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                       ?? "unknown";

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            await using var cmd = new SqlCommand(
                """
                UPDATE UserT
                SET ApprovedID   = 1,
                    ApprovedBy   = @ApprovedBy,
                    DateApproved = GETDATE(),
                    HasChanged   = 1,
                    LastUpdated  = GETDATE()
                WHERE UserTID   = @UserTID
                  AND Deleted   = 0
                  AND ApprovedID = 0
                """, conn);
            cmd.Parameters.AddWithValue("@ApprovedBy", approverTID);
            cmd.Parameters.AddWithValue("@UserTID",    userTID);

            var rows = await cmd.ExecuteNonQueryAsync();

            if (rows == 0)
                return NotFound(new { error = "User not found or account is already approved." });

            _logger.LogInformation(
                "User {UserTID} approved by {ApproverTID}.", userTID, approverTID);

            return Ok(new { message = "Account approved successfully." });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error approving user {UserTID}.", userTID);
            return StatusCode(500, new { error = "Approval failed. Please try again later." });
        }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  GET /api/auth/pending
    //  Returns all accounts awaiting approval. Requires Admin or SuperUser role.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    [HttpGet("pending")]
    [Authorize(Roles = "Admin,SuperUser")]
    public async Task<IActionResult> GetPendingUsers()
    {
        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            await using var cmd = new SqlCommand(
                """
                SELECT u.UserTID, u.FullName, u.UserName, u.EmailAddress,
                       u.PhoneNo, u.DataSourceID, u.CreatedAt,
                       c.GroupID, g.GroupName, c.CountyID, c.StateID, c.CountryID
                FROM UserT u
                LEFT JOIN CrossRefGpUsersT c ON c.UserTID = u.UserTID
                LEFT JOIN UserGroupT       g ON g.GroupID = c.GroupID
                WHERE u.ApprovedID = 0
                  AND u.Deleted    = 0
                ORDER BY u.CreatedAt ASC
                """, conn);

            await using var reader = await cmd.ExecuteReaderAsync();
            var results = new List<Dictionary<string, object?>>();
            while (await reader.ReadAsync())
            {
                var row = new Dictionary<string, object?>();
                for (int i = 0; i < reader.FieldCount; i++)
                    row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                results.Add(row);
            }

            return Ok(results);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching pending users.");
            return StatusCode(500, new { error = "Could not fetch pending users." });
        }
    }
}
