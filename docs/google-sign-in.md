# Google sign-in and instance access

Canonry manages accounts within each install. The same access model applies to
standard projects and advanced portfolios. There is no central identity service
and no project-specific membership in this version.

## Roles

| Role | Access |
| --- | --- |
| Viewer | Read reports and saved results. |
| Analyst | Viewer access plus bounded Research runs. Existing quotas and provider restrictions still apply. |
| Admin | Manage projects, settings, people and measurements. |

Service keys keep their existing scopes. A user-bound MCP connection can do only
what both its saved consent and the user's current role allow.

## Set up an instance

1. Keep a working root API key and password administrator for recovery.
   From the trusted CLI configuration, create the initial administrator:
   `canonry user create --name owner --role admin`. Enter the password at the
   hidden prompt. Automation can use `--password-stdin`.
2. Configure the externally reachable URL. For `canonry serve`, set
   `publicUrl` in the existing config file. A subpath must match `basePath`.
   For `apps/api`, use `CANONRY_PUBLIC_URL` and, if needed, `CANONRY_BASE_PATH`.
   HTTPS is required except for localhost development.
3. Create a separate Google OAuth web client for sign-in. This client uses only
   `openid email profile`; it does not grant Search Console, Analytics or other
   integration access.
4. In Settings → People & access → Google sign-in setup, copy the callback URL
   and register that exact URL in the Google client. For example:
   `https://dashboard.example.com/team/api/v1/auth/google/callback`.
5. Save the client ID and secret, then enable Google sign-in. Secrets are
   replace-only and are never returned by the settings API.
6. Invite one test person. Copy the single-use link and share it yourself.
   Canonry does not send an invitation email.

Local configuration uses this block in the existing config file:

```yaml
publicUrl: https://dashboard.example.com/team/
basePath: /team/
auth:
  google:
    enabled: true
    clientId: YOUR_GOOGLE_CLIENT_ID
    clientSecret: YOUR_GOOGLE_CLIENT_SECRET
```

Alternatively, use the deployment's protected environment settings:

- `CANONRY_GOOGLE_SIGN_IN_ENABLED=true`
- `CANONRY_GOOGLE_SIGN_IN_CLIENT_ID`
- `CANONRY_GOOGLE_SIGN_IN_CLIENT_SECRET`

An environment override makes Google sign-in settings read-only in the UI/API.
The cloud API host uses environment configuration. Local secrets stay in the
instance config file, outside the SQLite database.

The CLI can inspect configuration with `canonry user auth google status`.
Use `canonry user auth google configure --client-id <id> --client-secret-stdin`
to supply a secret through stdin, then `--enabled` to enable it.
Do not place secrets in command arguments.

## Invitations and existing accounts

- Invitations expire after seven days. Replacing or revoking a link invalidates
  the previous token. Accepted links cannot create another account.
- Invitations admit the exact invited email only when Google verifies a Gmail
  or Workspace identity. A Google account using a third-party email must first
  have a password account and explicitly link Google.
- Google identities are bound by issuer and subject, not by a mutable email.
  Matching an existing account's contact email never automatically links it.
- A password user links Google from their Account panel after entering their
  current password. Linking and unlinking are browser-only flows.
- An account cannot remove its last usable sign-in method.
- Accepted accounts receive the invitation's role. They can access every
  project in this instance.

CLI administration:

```text
canonry user list --format json
canonry user invite create --email analyst@example.com --role analyst --format json
canonry user invite list --format json
canonry user invite replace <invitation-id> --format json
canonry user invite revoke <invitation-id> --format json
canonry user update <user-id> --role viewer --format json
canonry user update <user-id> --display-name "Sample analyst" --email analyst@example.com --format json
canonry user suspend <user-id> --format json
canonry user reactivate <user-id> --format json
canonry user revoke-access <user-id> --format json
canonry user history <user-id> --format json
```

Equivalent authorized MCP tools cover account reads, role/status changes,
invitations and access revocation. They call the same API and do not bypass its
administrator or instance-scope checks. Account-administration MCP tools use an
explicitly authorized API key; browser OAuth connections retain their existing
read/Research consent scopes. Password bootstrap, secret configuration
and browser authentication remain explicit tool-catalog exceptions.

## Revocation, activity and recovery

Changing a role or status revokes existing browser sessions, OAuth grants and
user-bound MCP credentials. Revoking access signs the person out without
changing their role. A suspended person cannot sign in until reactivated.
Independent service keys are not reassigned to people or silently revoked.

People & access shows last sign-in. Details shows last foreground activity;
background dashboard polling does not count as a visit. Access history records
the authenticated actor, not a caller-supplied display name or tracing header.

Keep at least one active password administrator. If Google becomes unavailable,
use password sign-in. A trusted operator with the root key can create a
replacement password administrator through the CLI, then suspend the old account
and revoke its access. No direct database editing is required.
Once account authentication has been enabled, deleting accounts does not return
the install to unauthenticated access.

## Upgrade behavior

Existing account IDs, password digests, projects and measurements are preserved.
On the first upgrade, legacy Viewers who had the global Research grant become
Analysts. Other Viewers remain Viewers. Later changes to the legacy flag do not
change migrated roles. Existing delegated grants retain their original scope
ceiling; an upgrade does not add Research to a read-only grant.

Back up the database and config before upgrading. Migrations 155 and 156 extend
account storage; an older binary is not a supported rollback against the migrated
database. Restore the matching pre-upgrade database/config backup when rolling
back. Restoring a backup also restores the access state from that time.

## Smoke checkpoints

- Password sign-in and existing read-only access still work.
- One invited user can accept Google sign-in and gets the selected role.
- Viewer and Analyst cannot change instance settings or people.
- Analyst can run a mocked Research request; Viewer cannot.
- Suspending a user rejects their existing browser and delegated credentials.
- Password-admin recovery and last-method removal guards hold.
- Repeat the browser and MCP consent journey at the configured URL subpath.
- Test a real Google client and test account before production activation.

Local tests use disposable data and simulated Google transport. They do not
replace the final real-provider redirect and consent check.
