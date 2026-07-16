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
///   - Passwords are hashed with BCrypt (work factor 12) — never stored as
///     plaintext or reversible encoding.
///   - Forgot-password codes are BCrypt-hashed before storage so a DB read
///     alone cannot be used to reset an account.
///   - Timing-safe dummy BCrypt check on login prevents user-enumeration via
///     response time differences.
///   - Account-existence is not revealed in forgot-password responses
///     (always returns the same message — OWASP A07:2021).
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
    private readonly AuditService              _audit;

    public AuthController(
        IConfiguration config,
        TokenService tokenService,
        EmailService emailService,
        ILogger<AuthController> logger,
        AuditService audit)
    {
        _connectionString = config.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("DefaultConnection is not configured.");
        _tokenService = tokenService;
        _emailService = emailService;
        _config       = config;
        _logger       = logger;
        _audit        = audit;
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  GET /api/auth/check-username?username=x
    //  Returns 200 { available: true } or 200 { available: false }.
    //  Used by the registration form to give real-time feedback before submit.
    // ──────────────────────────────────────────────────────────────────────────
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

    // ──────────────────────────────────────────────────────────────────────────
    //  POST /api/auth/register
    //  Creates a new user account with ApprovedID = 0 (pending approval).
    //  The account cannot be used until an Admin or SuperUser approves it.
    // ──────────────────────────────────────────────────────────────────────────
    [HttpPost("register")]
    public async Task<IActionResult> Register([FromBody] RegisterRequest req)
    {
        // ── Input validation ──────────────────────────────────────────────
        if (string.IsNullOrWhiteSpace(req.FullName))
            return BadRequest(new { error = "FullName is required." });

        if (string.IsNullOrWhiteSpace(req.UserName))
            return BadRequest(new { error = "UserName is required." });

        if (string.IsNullOrWhiteSpace(req.EmailAddress))
            return BadRequest(new { error = "EmailAddress is required." });

        if (string.IsNullOrWhiteSpace(req.Password) || req.Password.Length < 8)
            return BadRequest(new { error = "Password must be at least 8 characters." });

        // ── Infer GroupID from geographic selections ───────────────────────────
        // Group 1 (Data Entrant)       — State + County + Facility selected, SubRecID ≠ 2.
        // Group 2 (County Supervisor)  — County selected without a facility, OR
        //                                State+County+Facility selected AND SubRecID = 2.
        // Group 3 (State Coordinator)  — State selected but no county or facility.
        // Group 4 (National)           — Nothing specific selected.
        int inferredGroupID;
        if (req.StateID > 0 && req.CountyID > 0 && req.HealthFacilityID > 0)
            inferredGroupID = (req.SubRecID == 2) ? 2 : 1;
        else if (req.CountyID > 0 && req.HealthFacilityID == 0)
            inferredGroupID = 2;
        else if (req.StateID > 0 && req.CountyID == 0 && req.HealthFacilityID == 0)
            inferredGroupID = 3;
        else
            inferredGroupID = 4;

        // DataSourceID in UserT mirrors HealthFacilityID so data-access queries can filter by facility.
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

            // ── Insert into UserT ─────────────────────────────────────────
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

            // ── Insert into CrossRefGpUsersT ──────────────────────────────
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
                     @DTLS, @Zonal, @NTP, @NGO, @SubRecID,
                     0, 1, 0, 0, 0)
                """, conn, tx);
            insertCross.Parameters.AddWithValue("@UserTID",    userTID);
            insertCross.Parameters.AddWithValue("@GroupID",    inferredGroupID);
            insertCross.Parameters.AddWithValue("@CountyID",   req.CountyID);
            insertCross.Parameters.AddWithValue("@StateID",    req.StateID);
            insertCross.Parameters.AddWithValue("@LocationID", req.LocationID);
            insertCross.Parameters.AddWithValue("@DTLS",       inferredGroupID == 2 ? 1 : 0);
            insertCross.Parameters.AddWithValue("@Zonal",      inferredGroupID == 3 ? 1 : 0);
            insertCross.Parameters.AddWithValue("@NTP",        inferredGroupID == 4 ? 1 : 0);
            insertCross.Parameters.AddWithValue("@NGO",        isNGO ? 1 : 0);
            insertCross.Parameters.AddWithValue("@SubRecID",   req.SubRecID);
            await insertCross.ExecuteNonQueryAsync();

            await tx.CommitAsync();

            _logger.LogInformation("New user registered: {UserTID}, GroupID={GroupID}", userTID, inferredGroupID);
            await _audit.LogAsync(
                $"New user account registered: {req.FullName.Trim()} ({req.UserName.Trim()})",
                userTID: userTID);

            return CreatedAtAction(nameof(Register), new
            {
                message = "Account created. An administrator will review and approve your account before you can log in.",
                userTID
            });
        }
        catch (SqlException ex) when (ex.Number is 2627 or 2601)
        {
            // Unique constraint violation — race condition between check and insert.
            return Conflict(new { error = "UserName or EmailAddress is already in use." });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during user registration.");
            return StatusCode(500, new { error = "Registration failed. Please try again later." });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GET /api/auth/states
    //  Returns the state list for the cascading location dropdowns.
    //  No authentication required (used on the public registration form).
    // ─────────────────────────────────────────────────────────────────────────
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
                SELECT HealthFacilityID, HealthFacility FROM HealthFacilityT WHERE CountyID = @CountyID AND eTBrDHIS = 1
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

    // ─────────────────────────────────────────────────────────────────────────
    //  GET /api/auth/subrecipients
    //  Returns NGO sub-recipient partners for the registration cascade.
    //  No authentication required (used on the public registration form).
    // ─────────────────────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────────────────
    //  GET /api/auth/locations?subRecId=X
    //  Returns NGO field locations for the selected sub-recipient.
    //  No authentication required (used on the public registration form).
    // ─────────────────────────────────────────────────────────────────────────
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

    // ──────────────────────────────────────────────────────────────────────────
    //  POST /api/auth/login
    //  Validates credentials and returns a signed JWT on success.
    // ──────────────────────────────────────────────────────────────────────────
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
                SELECT u.UserID, u.UserTID, u.UserName, u.FullName, u.EmailAddress, u.PwdHash,
                       u.DataSourceID, u.ApprovedID,
                       c.GroupID, c.CountyID, c.StateID, c.CountryID,
                       c.DTLS, c.Zonal, c.NTP, c.NGO,
                       c.SubRecID, c.LocationID,
                       c.AdminID, c.SuperUserID,
                       s.SubRec AS NgoName
                FROM UserT u
                LEFT JOIN CrossRefGpUsersT c ON c.UserTID = u.UserTID
                LEFT JOIN SubRecT s          ON s.SubRecID = c.SubRecID AND c.SubRecID > 0
                WHERE u.UserName = @UserName
                  AND u.Deleted  = 0
                """, conn);
            cmd.Parameters.AddWithValue("@UserName", req.UserName.Trim());

            await using var reader = await cmd.ExecuteReaderAsync();

            if (!await reader.ReadAsync())
            {
                // User not found — still do a BCrypt check to keep response time
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

            // ── Build role list ───────────────────────────────────────────
            bool dtls       = reader["DTLS"]       != DBNull.Value && Convert.ToBoolean(reader["DTLS"]);
            bool zonal      = reader["Zonal"]      != DBNull.Value && Convert.ToBoolean(reader["Zonal"]);
            bool ntp        = reader["NTP"]        != DBNull.Value && Convert.ToBoolean(reader["NTP"]);
            bool ngo        = reader["NGO"]        != DBNull.Value && Convert.ToBoolean(reader["NGO"]);
            int  adminID    = reader["AdminID"]    == DBNull.Value ? 0 : Convert.ToInt32(reader["AdminID"]);
            int  superUser  = reader["SuperUserID"] == DBNull.Value ? 0 : Convert.ToInt32(reader["SuperUserID"]);
            string ngoName  = reader["NgoName"]    == DBNull.Value ? string.Empty : reader["NgoName"].ToString()!;

            var roles = new List<string>();
            if (superUser == 1) roles.Add("SuperUser");
            if (adminID   == 1) roles.Add("Admin");
            if (ntp)            roles.Add("National");
            if (zonal)          roles.Add("StateCoordinator");
            if (dtls)           roles.Add("CountySupervisor");
            if (ngo)            roles.Add("NGO");
            if (roles.Count == 0 || (!ntp && !zonal && !dtls && !ngo))
                roles.Add("DataEntrant");

            var userID   = reader["UserID"]    == DBNull.Value ? 0 : Convert.ToInt32(reader["UserID"]);
            var tokenData = new UserTokenData
            {
                UserID       = userID,
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
            await _audit.LogAsync(
                $"{tokenData.FullName} ({tokenData.UserName}) logged in",
                userTID: tokenData.UserTID);

            return Ok(new LoginResponse
            {
                Token        = token,
                ExpiresAt    = DateTime.UtcNow.AddHours(expiryHours),
                UserID       = userID,
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
                Roles        = roles,
                NgoName      = ngoName
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during login.");
            return StatusCode(500, new { error = "Login failed. Please try again later." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  POST /api/auth/forgot-password
    //  Generates a 6-digit one-time reset code valid for 30 minutes.
    //
    //  SECURITY: The response is always identical whether or not the email
    //  exists. This prevents email-enumeration attacks (OWASP A07).
    //
    //  This endpoint generates a one-time 6-digit reset code, stores a BCrypt-
    //  hashed version in the database, and sends the code by email to the
    //  supplied address. The response is intentionally identical whether or not
    //  the email exists to prevent account enumeration.
    // ──────────────────────────────────────────────────────────────────────────
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

            // 6-digit code — sufficient entropy for a 30-minute window.
            var code     = Random.Shared.Next(100_000, 1_000_000).ToString();
            // Lower work factor (10) is acceptable here because the code expires
            // in 30 minutes and is 6 digits — BCrypt is just preventing a DB read
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
            await _audit.LogAsync("Password reset code requested", userTID: userTID);

            var sendTo = req.EmailAddress.Trim();
            _logger.LogInformation("Attempting reset email to: [{EmailAddress}]", sendTo);

            bool emailSent;
            try
            {
                emailSent = await _emailService.SendPasswordResetCodeAsync(sendTo, code);
            }
            catch (Exception emailEx)
            {
                _logger.LogError(emailEx, "Exception from SendPasswordResetCodeAsync for [{EmailAddress}]", sendTo);
                emailSent = false;
            }

            _logger.LogInformation("Reset email result for [{EmailAddress}]: {Result}", sendTo, emailSent ? "sent" : "FAILED");

            return Ok(new { message = safeMsg });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during forgot-password.");
            return StatusCode(500, new { error = "An error occurred. Please try again later." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  POST /api/auth/reset-password
    //  Validates the one-time code and updates the password hash.
    // ──────────────────────────────────────────────────────────────────────────
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
                SELECT UserTID, FullName, EmailAddress, FgtPwdCodeHash, FgtPwdExpiry
                FROM UserT
                WHERE UserName = @UserName AND Deleted = 0
                """, conn);
            cmd.Parameters.AddWithValue("@UserName", req.UserName.Trim());

            await using var reader = await cmd.ExecuteReaderAsync();
            if (!await reader.ReadAsync())
                return BadRequest(new { error = "Invalid reset request." });

            var userTID   = reader["UserTID"].ToString()!;
            var fullName  = reader["FullName"]?.ToString() ?? string.Empty;
            var userEmail = reader["EmailAddress"]?.ToString() ?? string.Empty;
            var codeHash  = reader["FgtPwdCodeHash"]?.ToString();
            var expiry    = reader["FgtPwdExpiry"] == DBNull.Value
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
            await _audit.LogAsync("Password reset completed", userTID: userTID);

            if (!string.IsNullOrWhiteSpace(userEmail))
            {
                _logger.LogInformation("Attempting password-changed email to: [{Email}]", userEmail);
                bool emailSent;
                try
                {
                    emailSent = await _emailService.SendPasswordChangedAsync(userEmail, fullName);
                }
                catch (Exception emailEx)
                {
                    _logger.LogError(emailEx, "Exception from SendPasswordChangedAsync for [{Email}]", userEmail);
                    emailSent = false;
                }
                _logger.LogInformation("Password-changed email result for [{Email}]: {Result}", userEmail, emailSent ? "sent" : "FAILED");
            }

            return Ok(new { message = "Password reset successful. You can now log in." });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during reset-password.");
            return StatusCode(500, new { error = "An error occurred. Please try again later." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  POST /api/auth/approve/{userTID}
    //  Marks a pending account as approved. Requires Admin or SuperUser role.
    //  Scoped: NGO SuperUsers can only approve users in the same SubRecID.
    //          MoH SuperUsers can only approve MoH users (SubRecID = 0).
    // ──────────────────────────────────────────────────────────────────────────
    [HttpPost("approve/{userTID}")]
    [Authorize(Roles = "Admin,SuperUser")]
    public async Task<IActionResult> ApproveUser(string userTID)
    {
        var approverTID    = User.FindFirstValue(ClaimTypes.NameIdentifier)
                          ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                          ?? "unknown";
        var approverSubRec = int.TryParse(User.FindFirstValue("sub_rec_id"), out var sr) ? sr : 0;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // Load the target user so we can check scope and send email.
            await using var loadCmd = new SqlCommand(
                """
                SELECT u.FullName, u.EmailAddress, c.SubRecID
                FROM UserT u
                LEFT JOIN CrossRefGpUsersT c ON c.UserTID = u.UserTID
                WHERE u.UserTID   = @UserTID
                  AND u.Deleted   = 0
                  AND u.ApprovedID = 0
                """, conn);
            loadCmd.Parameters.AddWithValue("@UserTID", userTID);

            string? fullName = null, email = null;
            int     targetSubRec = 0;
            await using (var reader = await loadCmd.ExecuteReaderAsync())
            {
                if (!await reader.ReadAsync())
                    return NotFound(new { error = "User not found or account is already approved." });
                fullName     = reader["FullName"]?.ToString();
                email        = reader["EmailAddress"]?.ToString();
                targetSubRec = reader["SubRecID"] == DBNull.Value ? 0 : Convert.ToInt32(reader["SubRecID"]);
            }

            // Scope check: approver can only approve users in their own organisation.
            if (approverSubRec != targetSubRec)
                return Forbid(); // 403 — wrong organisation

            await using var cmd = new SqlCommand(
                """
                UPDATE UserT
                SET ApprovedID   = 1,
                    ApprovedBy   = @ApprovedBy,
                    DateApproved = GETDATE(),
                    HasChanged   = 1,
                    LastUpdated  = GETDATE()
                WHERE UserTID    = @UserTID
                  AND Deleted    = 0
                  AND ApprovedID = 0
                """, conn);
            cmd.Parameters.AddWithValue("@ApprovedBy", approverTID);
            cmd.Parameters.AddWithValue("@UserTID",    userTID);
            await cmd.ExecuteNonQueryAsync();

            _logger.LogInformation("User {UserTID} approved by {ApproverTID}.", userTID, approverTID);
            await _audit.LogAsync($"Approved user account {userTID}", userTID: approverTID);

            // Send approval email (fire-and-forget — do not fail the response if email fails).
            if (!string.IsNullOrWhiteSpace(email))
            {
                _ = Task.Run(async () =>
                {
                    try   { await _emailService.SendAccountApprovedAsync(email, fullName ?? "User"); }
                    catch (Exception ex) { _logger.LogWarning(ex, "Approval email failed for {Email}.", email); }
                });
            }

            return Ok(new { message = "Account approved successfully." });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error approving user {UserTID}.", userTID);
            return StatusCode(500, new { error = "Approval failed. Please try again later." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  POST /api/auth/reject/{userTID}
    //  Rejects (soft-deletes) a pending account. Requires Admin or SuperUser role.
    //  Scoped: same SubRecID rule as ApproveUser.
    // ──────────────────────────────────────────────────────────────────────────
    [HttpPost("reject/{userTID}")]
    [Authorize(Roles = "Admin,SuperUser")]
    public async Task<IActionResult> RejectUser(string userTID)
    {
        var approverTID    = User.FindFirstValue(ClaimTypes.NameIdentifier)
                          ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                          ?? "unknown";
        var approverSubRec = int.TryParse(User.FindFirstValue("sub_rec_id"), out var sr) ? sr : 0;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // Load target user for scope check and email.
            await using var loadCmd = new SqlCommand(
                """
                SELECT u.FullName, u.EmailAddress, c.SubRecID
                FROM UserT u
                LEFT JOIN CrossRefGpUsersT c ON c.UserTID = u.UserTID
                WHERE u.UserTID    = @UserTID
                  AND u.Deleted    = 0
                  AND u.ApprovedID = 0
                """, conn);
            loadCmd.Parameters.AddWithValue("@UserTID", userTID);

            string? fullName = null, email = null;
            int     targetSubRec = 0;
            await using (var reader = await loadCmd.ExecuteReaderAsync())
            {
                if (!await reader.ReadAsync())
                    return NotFound(new { error = "User not found or account is not pending." });
                fullName     = reader["FullName"]?.ToString();
                email        = reader["EmailAddress"]?.ToString();
                targetSubRec = reader["SubRecID"] == DBNull.Value ? 0 : Convert.ToInt32(reader["SubRecID"]);
            }

            if (approverSubRec != targetSubRec)
                return Forbid();

            // ApprovedID = 2 = rejected; Deleted = 1 so they cannot log in.
            await using var cmd = new SqlCommand(
                """
                UPDATE UserT
                SET ApprovedID  = 2,
                    Deleted     = 1,
                    HasChanged  = 1,
                    LastUpdated = GETDATE()
                WHERE UserTID   = @UserTID
                  AND Deleted   = 0
                """, conn);
            cmd.Parameters.AddWithValue("@UserTID", userTID);
            await cmd.ExecuteNonQueryAsync();

            _logger.LogInformation("User {UserTID} rejected by {ApproverTID}.", userTID, approverTID);
            await _audit.LogAsync($"Rejected user account {userTID}", userTID: approverTID);

            if (!string.IsNullOrWhiteSpace(email))
            {
                _ = Task.Run(async () =>
                {
                    try   { await _emailService.SendAccountRejectedAsync(email, fullName ?? "User"); }
                    catch (Exception ex) { _logger.LogWarning(ex, "Rejection email failed for {Email}.", email); }
                });
            }

            return Ok(new { message = "Account rejected." });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error rejecting user {UserTID}.", userTID);
            return StatusCode(500, new { error = "Rejection failed. Please try again later." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  GET /api/auth/users
    //  Returns all active (approved) users scoped to the caller's organisation.
    //  Excludes the caller's own account. Requires Admin or SuperUser role.
    // ──────────────────────────────────────────────────────────────────────────
    [HttpGet("users")]
    [Authorize(Roles = "Admin,SuperUser")]
    public async Task<IActionResult> GetUsers()
    {
        var callerTID      = User.FindFirstValue(ClaimTypes.NameIdentifier)
                          ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                          ?? string.Empty;
        var callerSubRec   = int.TryParse(User.FindFirstValue("sub_rec_id"), out var sr) ? sr : 0;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            await using var cmd = new SqlCommand(
                """
                SELECT u.UserTID, u.FullName, u.UserName, u.EmailAddress,
                       u.PhoneNo, u.DataSourceID, u.DateApproved,
                       c.GroupID, g.GroupName, c.SubRecID, c.NGO,
                       c.AdminID, c.SuperUserID, s.SubRec
                FROM UserT u
                LEFT JOIN CrossRefGpUsersT c ON c.UserTID = u.UserTID
                LEFT JOIN UserGroupT       g ON g.GroupID  = c.GroupID
                LEFT JOIN SubRecT          s ON s.SubRecID = c.SubRecID
                WHERE u.ApprovedID = 1
                  AND u.Deleted    = 0
                  AND u.UserTID   <> @CallerTID
                  AND (c.SubRecID  = @CallerSubRec
                       OR (c.SubRecID IS NULL AND @CallerSubRec = 0))
                ORDER BY u.FullName ASC
                """, conn);
            cmd.Parameters.AddWithValue("@CallerTID",    callerTID);
            cmd.Parameters.AddWithValue("@CallerSubRec", callerSubRec);

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
            _logger.LogError(ex, "Error fetching active users.");
            return StatusCode(500, new { error = "Could not fetch users." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  DELETE /api/auth/users/{userTID}
    //  Soft-deletes (deactivates) an active user account.
    //  Cannot delete own account. Scoped by SubRecID. Requires Admin or SuperUser.
    // ──────────────────────────────────────────────────────────────────────────
    [HttpDelete("users/{userTID}")]
    [Authorize(Roles = "Admin,SuperUser")]
    public async Task<IActionResult> DeleteUser(string userTID)
    {
        var callerTID    = User.FindFirstValue(ClaimTypes.NameIdentifier)
                        ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                        ?? string.Empty;
        var callerSubRec = int.TryParse(User.FindFirstValue("sub_rec_id"), out var sr) ? sr : 0;

        if (string.Equals(callerTID, userTID, StringComparison.OrdinalIgnoreCase))
            return BadRequest(new { error = "You cannot deactivate your own account." });

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // Load target to check scope.
            await using var loadCmd = new SqlCommand(
                """
                SELECT u.FullName, c.SubRecID, c.SuperUserID, c.AdminID
                FROM UserT u
                LEFT JOIN CrossRefGpUsersT c ON c.UserTID = u.UserTID
                WHERE u.UserTID  = @UserTID
                  AND u.Deleted  = 0
                  AND u.ApprovedID = 1
                """, conn);
            loadCmd.Parameters.AddWithValue("@UserTID", userTID);

            string? fullName = null;
            int targetSubRec = 0, targetSuperUser = 0, targetAdmin = 0;
            await using (var reader = await loadCmd.ExecuteReaderAsync())
            {
                if (!await reader.ReadAsync())
                    return NotFound(new { error = "User not found or already deactivated." });
                fullName        = reader["FullName"]?.ToString();
                targetSubRec    = reader["SubRecID"]    == DBNull.Value ? 0 : Convert.ToInt32(reader["SubRecID"]);
                targetSuperUser = reader["SuperUserID"] == DBNull.Value ? 0 : Convert.ToInt32(reader["SuperUserID"]);
                targetAdmin     = reader["AdminID"]     == DBNull.Value ? 0 : Convert.ToInt32(reader["AdminID"]);
            }

            // Scope check.
            if (callerSubRec != targetSubRec)
                return Forbid();

            // Prevent deactivating another SuperUser or Admin (only a higher-level admin should do that).
            if (targetSuperUser == 1 || targetAdmin == 1)
                return BadRequest(new { error = "Super-user and admin accounts can only be managed at the database level." });

            await using var cmd = new SqlCommand(
                """
                UPDATE UserT
                SET Deleted     = 1,
                    HasChanged  = 1,
                    LastUpdated = GETDATE()
                WHERE UserTID   = @UserTID
                  AND Deleted   = 0
                """, conn);
            cmd.Parameters.AddWithValue("@UserTID", userTID);
            await cmd.ExecuteNonQueryAsync();

            _logger.LogInformation("User {UserTID} deactivated by {CallerTID}.", userTID, callerTID);
            await _audit.LogAsync($"Deactivated user account: {fullName} ({userTID})", userTID: callerTID);

            return Ok(new { message = $"Account for '{fullName}' has been deactivated." });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deactivating user {UserTID}.", userTID);
            return StatusCode(500, new { error = "Deactivation failed. Please try again later." });
        }
    }

    //  NGO SuperUser  → only users with the same SubRecID.
    //  MoH SuperUser  → only MoH users (SubRecID = 0).
    //  Requires Admin or SuperUser role.
    // ──────────────────────────────────────────────────────────────────────────
    [HttpGet("pending")]
    [Authorize(Roles = "Admin,SuperUser")]
    public async Task<IActionResult> GetPendingUsers()
    {
        var approverSubRec = int.TryParse(User.FindFirstValue("sub_rec_id"), out var sr) ? sr : 0;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            await using var cmd = new SqlCommand(
                """
                SELECT u.UserTID, u.FullName, u.UserName, u.EmailAddress,
                       u.PhoneNo, u.DataSourceID, u.CreatedAt,
                       c.GroupID, g.GroupName, c.CountyID, c.StateID, c.CountryID,
                       c.SubRecID, c.NGO, s.SubRec
                FROM UserT u
                LEFT JOIN CrossRefGpUsersT c ON c.UserTID = u.UserTID
                LEFT JOIN UserGroupT       g ON g.GroupID  = c.GroupID
                LEFT JOIN SubRecT          s ON s.SubRecID = c.SubRecID
                WHERE u.ApprovedID = 0
                  AND u.Deleted    = 0
                  AND (c.SubRecID  = @ApproverSubRec
                       OR (c.SubRecID IS NULL AND @ApproverSubRec = 0))
                ORDER BY u.CreatedAt ASC
                """, conn);
            cmd.Parameters.AddWithValue("@ApproverSubRec", approverSubRec);

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

    // ──────────────────────────────────────────────────────────────────────────
    //  POST /api/auth/heartbeat
    //  Updates LastSeenAt for the authenticated user so active sessions can
    //  be tracked.  Called by the PWA every 5 minutes.
    // ──────────────────────────────────────────────────────────────────────────
    [HttpPost("heartbeat")]
    [Authorize]
    public async Task<IActionResult> Heartbeat()
    {
        var callerTID = User.FindFirstValue(ClaimTypes.NameIdentifier)
                     ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                     ?? string.Empty;
        if (string.IsNullOrEmpty(callerTID)) return Unauthorized();

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            await using var cmd = new SqlCommand(
                """
                UPDATE UserT SET LastSeenAt = GETUTCDATE()
                WHERE UserTID = @UserTID AND Deleted = 0 AND ApprovedID = 1
                """, conn);
            cmd.Parameters.AddWithValue("@UserTID", callerTID);
            await cmd.ExecuteNonQueryAsync();

            return Ok();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Heartbeat update failed for {UserTID}.", callerTID);
            return StatusCode(500);
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  GET /api/auth/sessions
    //  Returns all users who have been active in the last 60 minutes.
    //  Scoped to the caller's organisation (SubRecID). Requires Admin or SuperUser.
    // ──────────────────────────────────────────────────────────────────────────
    [HttpGet("sessions")]
    [Authorize(Roles = "Admin,SuperUser")]
    public async Task<IActionResult> GetActiveSessions()
    {
        var callerSubRec = int.TryParse(User.FindFirstValue("sub_rec_id"), out var sr) ? sr : 0;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            await using var cmd = new SqlCommand(
                """
                SELECT u.UserTID, u.FullName, u.UserName, u.LastSeenAt,
                       g.GroupName, c.SubRecID
                FROM UserT u
                LEFT JOIN CrossRefGpUsersT c ON c.UserTID = u.UserTID
                LEFT JOIN UserGroupT       g ON g.GroupID  = c.GroupID
                WHERE u.ApprovedID = 1
                  AND u.Deleted    = 0
                  AND u.LastSeenAt IS NOT NULL
                  AND u.LastSeenAt >= DATEADD(MINUTE, -60, GETUTCDATE())
                  AND (c.SubRecID  = @CallerSubRec
                       OR (c.SubRecID IS NULL AND @CallerSubRec = 0))
                ORDER BY u.LastSeenAt DESC
                """, conn);
            cmd.Parameters.AddWithValue("@CallerSubRec", callerSubRec);

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
            _logger.LogError(ex, "Error fetching active sessions.");
            return StatusCode(500, new { error = "Could not fetch active sessions." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  GET /api/auth/users/{userTID}/facilities
    //  Returns the explicit facility IDs assigned to the given user.
    //  An empty list means "use default scope rules" (county / state).
    //  Requires Admin or SuperUser role.
    // ──────────────────────────────────────────────────────────────────────────
    [HttpGet("users/{userTID}/facilities")]
    [Authorize(Roles = "Admin,SuperUser")]
    public async Task<IActionResult> GetUserFacilities(string userTID)
    {
        var callerSubRec = int.TryParse(User.FindFirstValue("sub_rec_id"), out var sr) ? sr : 0;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // Scope check: only manage users in the same organisation.
            await using var scopeCmd = new SqlCommand(
                "SELECT SubRecID FROM CrossRefGpUsersT WHERE UserTID = @UserTID", conn);
            scopeCmd.Parameters.AddWithValue("@UserTID", userTID);
            var rawSubRec = await scopeCmd.ExecuteScalarAsync();
            int targetSR  = rawSubRec == null || rawSubRec == DBNull.Value
                ? 0 : Convert.ToInt32(rawSubRec);
            if (callerSubRec != targetSR) return Forbid();

            await using var cmd = new SqlCommand(
                """
                SELECT f.HealthFacilityID, hf.HealthFacility
                FROM UserFacilitiesT f
                JOIN HealthFacilityT hf ON hf.HealthFacilityID = f.HealthFacilityID
                WHERE f.UserTID = @UserTID
                ORDER BY hf.HealthFacility
                """, conn);
            cmd.Parameters.AddWithValue("@UserTID", userTID);

            await using var reader = await cmd.ExecuteReaderAsync();
            var results = new List<Dictionary<string, object?>>();
            while (await reader.ReadAsync())
            {
                results.Add(new Dictionary<string, object?>
                {
                    ["healthFacilityID"] = reader.GetInt32(0),
                    ["healthFacility"]   = reader.GetString(1),
                });
            }

            return Ok(results);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching facilities for user {UserTID}.", userTID);
            return StatusCode(500, new { error = "Could not fetch user facilities." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  PUT /api/auth/users/{userTID}/facilities
    //  Replaces a user's explicit facility assignments atomically.
    //  Sending an empty array clears all assignments (reverts to default scope).
    //  Requires Admin or SuperUser role.
    // ──────────────────────────────────────────────────────────────────────────
    [HttpPut("users/{userTID}/facilities")]
    [Authorize(Roles = "Admin,SuperUser")]
    public async Task<IActionResult> PutUserFacilities(
        string userTID, [FromBody] UserFacilitiesRequest req)
    {
        var callerTID    = User.FindFirstValue(ClaimTypes.NameIdentifier)
                        ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                        ?? string.Empty;
        var callerSubRec = int.TryParse(User.FindFirstValue("sub_rec_id"), out var sr) ? sr : 0;

        if (string.Equals(callerTID, userTID, StringComparison.OrdinalIgnoreCase))
            return BadRequest(new { error = "You cannot edit your own facility assignments." });

        var ids = req.FacilityIds ?? [];
        if (ids.Count > 5000)
            return BadRequest(new { error = "Too many facilities in a single request." });

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // Scope + existence check.
            await using var scopeCmd = new SqlCommand(
                """
                SELECT c.SubRecID, u.FullName
                FROM CrossRefGpUsersT c
                JOIN UserT u ON u.UserTID = c.UserTID
                WHERE c.UserTID = @UserTID AND u.Deleted = 0
                """, conn);
            scopeCmd.Parameters.AddWithValue("@UserTID", userTID);
            string? fullName  = null;
            int     targetSR  = 0;
            await using (var r = await scopeCmd.ExecuteReaderAsync())
            {
                if (!await r.ReadAsync())
                    return NotFound(new { error = "User not found." });
                targetSR = r["SubRecID"] == DBNull.Value ? 0 : Convert.ToInt32(r["SubRecID"]);
                fullName = r["FullName"]?.ToString();
            }
            if (callerSubRec != targetSR) return Forbid();

            await using var tx = (SqlTransaction)await conn.BeginTransactionAsync();

            // Replace all assignments atomically.
            await using var del = new SqlCommand(
                "DELETE FROM UserFacilitiesT WHERE UserTID = @UserTID", conn, tx);
            del.Parameters.AddWithValue("@UserTID", userTID);
            await del.ExecuteNonQueryAsync();

            foreach (var facId in ids.Distinct())
            {
                await using var ins = new SqlCommand(
                    """
                    INSERT INTO UserFacilitiesT (UserTID, HealthFacilityID, CreatedAt, CreatedBy)
                    VALUES (@UserTID, @FacID, GETDATE(), @CreatedBy)
                    """, conn, tx);
                ins.Parameters.AddWithValue("@UserTID",   userTID);
                ins.Parameters.AddWithValue("@FacID",     facId);
                ins.Parameters.AddWithValue("@CreatedBy", callerTID);
                await ins.ExecuteNonQueryAsync();
            }

            await tx.CommitAsync();

            _logger.LogInformation(
                "Facility assignments updated for {UserTID} by {CallerTID}. Count={Count}",
                userTID, callerTID, ids.Count);
            await _audit.LogAsync(
                $"Updated facility assignments for {fullName}: {ids.Count} facilit{(ids.Count == 1 ? "y" : "ies")}",
                userTID: callerTID);

            return Ok(new
            {
                message = $"Facility assignments updated ({ids.Count} facilit{(ids.Count == 1 ? "y" : "ies")})."
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating facilities for user {UserTID}.", userTID);
            return StatusCode(500, new { error = "Could not update facility assignments." });
        }
    }
}
