#!/usr/bin/env bash
# =============================================================================
# grant_workspace_admin.sh — post-deploy helper (workspace admin on every
# workspace attached to the app's metastore).
#
# WHY THIS EXISTS
#   Unity Catalog system tables are metastore-wide, so the app sees jobs,
#   notebooks and pipelines that ran in OTHER workspaces on the same metastore.
#   Fetching their source for transformation lineage means calling THAT
#   workspace's APIs as the app's service principal. A SP that is merely known
#   to a workspace (SCIM-added, no entitlements) fails every call with
#
#     This API is disabled for users without the workspace-access entitlement
#
#   and without object ACLs it can't read other people's jobs/notebooks. Making
#   it a workspace admin on each attached workspace covers both.
#
# TWO MODES (picked automatically)
#   Account mode   — pass --account-profile <account-level CLI profile> (account
#                    admin). Lists every workspace assigned to the metastore and
#                    sets the SP's workspace assignment to ADMIN on each. Covers
#                    ALL attached workspaces, including ones you have no profile for.
#   Workspace mode — no --account-profile. Scans your ~/.databrickscfg workspace
#                    profiles (or --workspace-profiles "p1 p2"), keeps those on the
#                    same metastore, and adds the SP to each one's `admins` group
#                    (adding the SP to the workspace first if needed). Needs only
#                    workspace admin, but reaches ONLY workspaces you have a
#                    profile for — others are not discoverable without account admin.
#
#   Note the scope: this makes the app SP an admin of every attached workspace,
#   including the one hosting the app. Use --dry-run to see the list first.
#
#   Idempotent: existing assignments / memberships are reported and left alone.
#
# Usage:
#   ./grant_workspace_admin.sh --profile <cli-profile> [--app <app-name>] \
#       [--account-profile <account-profile>] [--workspace-profiles "p1 p2"] [--dry-run]
#
# Env-var equivalents: PROFILE, APP_NAME, ACCOUNT_PROFILE, WORKSPACE_PROFILES
# =============================================================================
set -euo pipefail

APP_NAME="${APP_NAME:-bricktrace-dev}"
PROFILE="${PROFILE:-DEFAULT}"
ACCOUNT_PROFILE="${ACCOUNT_PROFILE:-}"
WORKSPACE_PROFILES="${WORKSPACE_PROFILES:-}"
DRY_RUN=0

need_val() {  # need_val <flag> [remaining args...]
  [[ $# -ge 2 && -n "${2:-}" ]] || { echo "ERROR: $1 requires a value." >&2; exit 2; }
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)                need_val "$@"; APP_NAME="$2"; shift 2 ;;
    --profile)            need_val "$@"; PROFILE="$2"; shift 2 ;;
    --account-profile)    need_val "$@"; ACCOUNT_PROFILE="$2"; shift 2 ;;
    --workspace-profiles) need_val "$@"; WORKSPACE_PROFILES="$2"; shift 2 ;;
    --dry-run)            DRY_RUN=1; shift ;;
    -h|--help)            sed -n '2,/^# =\{10,\}$/p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# json_get <python-expr over `d`> — reads JSON on stdin, prints the expression or
# nothing. Never fails: under `set -e`/`pipefail` a parse error would otherwise
# abort before the curated error that checks for the empty result.
json_get() {
  python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    v = eval(sys.argv[1])
    if v is not None and v != "":
        print(v)
except Exception:
    pass
' "$1" 2>/dev/null || true
}

echo "Resolving app '$APP_NAME' (profile: $PROFILE)…"
SPN="$(databricks apps get "$APP_NAME" --profile "$PROFILE" -o json 2>/dev/null \
  | json_get 'd.get("service_principal_client_id")')"
if [[ -z "$SPN" ]]; then
  echo "ERROR: could not resolve the service principal of app '$APP_NAME' as profile '$PROFILE'." >&2
  echo "       Is the app deployed? Try: databricks apps get $APP_NAME --profile $PROFILE" >&2
  exit 1
fi
METASTORE_ID="$(databricks metastores current --profile "$PROFILE" -o json 2>/dev/null \
  | json_get 'd.get("metastore_id")')"
if [[ -z "$METASTORE_ID" ]]; then
  echo "ERROR: could not read the current metastore for profile '$PROFILE'." >&2
  exit 1
fi
echo "  service principal : $SPN"
echo "  metastore         : $METASTORE_ID"

FAILED=0

# ---------------------------------------------------------------------------
# Account mode
# ---------------------------------------------------------------------------
if [[ -n "$ACCOUNT_PROFILE" ]]; then
  echo "Account mode (profile: $ACCOUNT_PROFILE)"
  # The account-level SCIM id is what workspace assignment takes, not the app id.
  PRINCIPAL_ID="$(databricks account service-principals list --profile "$ACCOUNT_PROFILE" \
      --filter "applicationId eq $SPN" -o json 2>/dev/null \
    | json_get '(d if isinstance(d, list) else d.get("Resources", []))[0]["id"]')"
  if [[ -z "$PRINCIPAL_ID" ]]; then
    echo "ERROR: service principal $SPN not found in the account via '$ACCOUNT_PROFILE'." >&2
    echo "       Is that an account-level profile with account admin?" >&2
    exit 1
  fi
  WORKSPACE_IDS="$(databricks account metastore-assignments list "$METASTORE_ID" \
      --profile "$ACCOUNT_PROFILE" -o json 2>/dev/null \
    | json_get '" ".join(str(w.get("workspace_id", w) if isinstance(w, dict) else w)
                         for w in (d if isinstance(d, list) else d.get("workspace_ids", [])))')"
  if [[ -z "$WORKSPACE_IDS" ]]; then
    echo "ERROR: no workspaces listed for metastore $METASTORE_ID via '$ACCOUNT_PROFILE'." >&2
    exit 1
  fi
  for WID in $WORKSPACE_IDS; do
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "  [dry-run] workspace $WID: would assign ADMIN to principal $PRINCIPAL_ID"
      continue
    fi
    if databricks account workspace-assignment update "$WID" "$PRINCIPAL_ID" \
        --profile "$ACCOUNT_PROFILE" --json '{"permissions":["ADMIN"]}' >/dev/null; then
      echo "  workspace $WID: ADMIN"
    else
      echo "  workspace $WID: FAILED to assign ADMIN" >&2
      FAILED=1
    fi
  done
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# Workspace mode
# ---------------------------------------------------------------------------
if [[ -z "$WORKSPACE_PROFILES" ]]; then
  # Account-level profiles (accounts.* hosts) can't answer `metastores current`.
  WORKSPACE_PROFILES="$(databricks auth profiles --skip-validate -o json 2>/dev/null \
    | json_get '" ".join(p["name"] for p in d.get("profiles", [])
                         if "accounts." not in (p.get("host") or ""))')"
fi
echo "Workspace mode — checking profiles: ${WORKSPACE_PROFILES:-<none>}"

SEEN_WIDS=" "
for P in $WORKSPACE_PROFILES; do
  CUR="$(databricks metastores current --profile "$P" -o json 2>/dev/null || true)"
  MID="$(printf '%s' "$CUR" | json_get 'd.get("metastore_id")')"
  WID="$(printf '%s' "$CUR" | json_get 'd.get("workspace_id")')"
  if [[ -z "$MID" ]]; then
    echo "  $P: skipped (profile not usable — expired login?)"
    continue
  fi
  if [[ "$MID" != "$METASTORE_ID" ]]; then
    echo "  $P: skipped (workspace $WID is on another metastore)"
    continue
  fi
  # Several profiles can point at one workspace; grant once.
  [[ "$SEEN_WIDS" == *" $WID "* ]] && continue
  SEEN_WIDS+="$WID "

  SP_JSON="$(databricks service-principals list --profile "$P" \
      --filter "applicationId eq $SPN" -o json 2>/dev/null || true)"
  SP_ID="$(printf '%s' "$SP_JSON" \
    | json_get '(d if isinstance(d, list) else d.get("Resources", []))[0]["id"]')"
  ADMINS_ID="$(databricks groups list --profile "$P" \
      --filter 'displayName eq "admins"' -o json 2>/dev/null \
    | json_get '(d if isinstance(d, list) else d.get("Resources", []))[0]["id"]')"
  if [[ -z "$ADMINS_ID" ]]; then
    echo "  $P (workspace $WID): FAILED — can't read the admins group (are you a workspace admin?)" >&2
    FAILED=1
    continue
  fi
  # `groups list` omits members, so check from the SP's side.
  if [[ -n "$SP_ID" ]] && printf '%s' "$SP_JSON" | ADMINS_ID="$ADMINS_ID" python3 -c '
import os, sys, json
d = json.load(sys.stdin)
sp = (d if isinstance(d, list) else d.get("Resources", []))[0]
sys.exit(0 if any(g.get("value") == os.environ["ADMINS_ID"] for g in sp.get("groups") or []) else 1)
' 2>/dev/null; then
    echo "  $P (workspace $WID): already admin"
    continue
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  [dry-run] $P (workspace $WID): would $([[ -z "$SP_ID" ]] && echo "add the SP to the workspace, then ")add it to admins"
    continue
  fi

  if [[ -z "$SP_ID" ]]; then
    SP_ID="$(databricks service-principals create --profile "$P" -o json \
        --json "$(printf '{"applicationId":"%s","displayName":"%s"}' "$SPN" "$APP_NAME")" 2>/dev/null \
      | json_get 'd.get("id")')"
    if [[ -z "$SP_ID" ]]; then
      echo "  $P (workspace $WID): FAILED to add the SP to the workspace" >&2
      FAILED=1
      continue
    fi
  fi
  if databricks groups patch "$ADMINS_ID" --profile "$P" --json "$(printf \
      '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"add","path":"members","value":[{"value":"%s"}]}]}' \
      "$SP_ID")" >/dev/null; then
    echo "  $P (workspace $WID): added to admins"
  else
    echo "  $P (workspace $WID): FAILED to add to admins" >&2
    FAILED=1
  fi
done

if [[ "$SEEN_WIDS" == " " ]]; then
  echo "WARNING: no CLI profile points at a workspace on metastore $METASTORE_ID." >&2
fi
echo ""
echo "Workspaces on this metastore that you have no CLI profile for were NOT covered."
echo "Pass --account-profile <account-admin profile> to cover every attached workspace."
exit "$FAILED"
