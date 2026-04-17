#!/usr/bin/env bash
set -euo pipefail

REPO=""
MODE="light"
STATE="open"
LABEL_FILTER=""
TICKET_TYPE="bug"
OUTPUT_FORMAT="table"
LIMIT=50
TOP_N=20
COMMENT_LIMIT=5
ISSUE_CSV=""

usage() {
  cat <<'USAGE'
Usage:
  triage-github-issues.sh --repo <owner/repo> [options]

Options:
  --repo <owner/repo>          Repository to analyze (required unless issue refs embed repo)
  --issues <ref,ref,...>       Issue refs: URL, owner/repo#number, or number
  --mode <light|deep>          light=fast metadata triage (default), deep=adds comment-based analysis
  --state <open|closed|all>    Used when --issues is not provided (default: open)
  --label <name[,name...]>     Filter issues by label(s) in list mode; also filters --issues refs if provided
  --ticket-type <type>         bug (default), technical-todo, user-story, or all
  --output <table|json>        table=human output (default), json=machine-readable output
  --limit <N>                  Max issues to scan in list mode (default: 50)
  --top <N>                    In deep mode, analyze top N issues deeply (default: 20)
  --comments <N>               Max recent comments per issue for deep analysis (default: 5)
  -h, --help                   Show this help

Examples:
  triage-github-issues.sh --repo shopware/shopware --issues 15120
  triage-github-issues.sh --repo shopware/shopware --issues 15120 --ticket-type all
  triage-github-issues.sh --repo shopware/shopware --issues 15120,15121 --label regression
  triage-github-issues.sh --repo shopware/shopware --issues 13812,15120 --mode deep
  triage-github-issues.sh --repo shopware/shopware --mode light --label "bug,regression" --limit 100
  triage-github-issues.sh --repo shopware/shopware --mode light --output json --limit 100
  triage-github-issues.sh --repo shopware/shopware --mode light --limit 100
  triage-github-issues.sh --repo shopware/shopware --mode light --ticket-type technical-todo --limit 100
  triage-github-issues.sh --repo shopware/shopware --mode deep --limit 100 --top 20
USAGE
}

if ! command -v gh >/dev/null 2>&1; then
  echo "error: GitHub CLI (gh) is required." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required." >&2
  exit 1
fi

gh_api_json_retry() {
  local out=""
  local attempt
  for attempt in 1 2 3; do
    if out="$(gh api "$@" 2>/dev/null)"; then
      printf '%s' "$out"
      return 0
    fi
    sleep "$attempt"
  done
  return 1
}

while (( $# > 0 )); do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --issues)
      ISSUE_CSV="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --state)
      STATE="${2:-}"
      shift 2
      ;;
    --label)
      LABEL_FILTER="${2:-}"
      shift 2
      ;;
    --ticket-type)
      TICKET_TYPE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_FORMAT="${2:-}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    --top)
      TOP_N="${2:-}"
      shift 2
      ;;
    --comments)
      COMMENT_LIMIT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "$MODE" != "light" && "$MODE" != "deep" ]]; then
  echo "error: --mode must be light or deep" >&2
  exit 1
fi

if [[ "$STATE" != "open" && "$STATE" != "closed" && "$STATE" != "all" ]]; then
  echo "error: --state must be open, closed, or all" >&2
  exit 1
fi

case "$TICKET_TYPE" in
  bug|technical-todo|user-story|all)
    ;;
  technical_todo|todo)
    TICKET_TYPE="technical-todo"
    ;;
  user_story|story|feature)
    TICKET_TYPE="user-story"
    ;;
  *)
    echo "error: --ticket-type must be bug, technical-todo, user-story, or all" >&2
    exit 1
    ;;
esac

if [[ "$OUTPUT_FORMAT" != "table" && "$OUTPUT_FORMAT" != "json" ]]; then
  echo "error: --output must be table or json" >&2
  exit 1
fi

for pair in "LIMIT:$LIMIT" "TOP_N:$TOP_N" "COMMENT_LIMIT:$COMMENT_LIMIT"; do
  key="${pair%%:*}"
  val="${pair##*:}"
  if [[ ! "$val" =~ ^[0-9]+$ || "$val" -lt 1 ]]; then
    echo "error: $key must be a positive integer" >&2
    exit 1
  fi
done

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

decode_b64() {
  if base64 --decode >/dev/null 2>&1 <<<"$1"; then
    base64 --decode <<<"$1"
  else
    base64 -D <<<"$1"
  fi
}

parse_issue_ref() {
  local ref="$1"
  local default_repo="$2"
  local repo=""
  local number=""

  if [[ "$ref" =~ ^https?://github\.com/([^/]+)/([^/]+)/issues/([0-9]+) ]]; then
    repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    number="${BASH_REMATCH[3]}"
  elif [[ "$ref" =~ ^([^/]+/[^#]+)#([0-9]+)$ ]]; then
    repo="${BASH_REMATCH[1]}"
    number="${BASH_REMATCH[2]}"
  elif [[ "$ref" =~ ^[0-9]+$ ]]; then
    repo="$default_repo"
    number="$ref"
  else
    echo "error: unsupported issue ref: $ref" >&2
    return 1
  fi

  if [[ -z "$repo" ]]; then
    echo "error: repository is required for numeric issue ref: $ref" >&2
    return 1
  fi

  printf '%s %s\n' "$repo" "$number"
}

triage_filter_jq() {
  cat <<'JQ'
[.[]
  | def ticket_type:
      ((.body // "") | ascii_downcase) as $body
      | ([(.labels // [])[] | (.name // "" | ascii_downcase)]) as $labels
      | if (($labels | map(test("(^|/)bug$|type/bug|kind/bug|category/bug")) | any)
            or ($body | test("^###\\s*shopware\\s+version"; "m"))
            or ($body | test("###\\s*actual\\s+behaviou?r"; "m")))
        then "bug"
        elif (($labels | map(test("type/todo|technical\\s*todo|category/todo")) | any)
              or ($body | test("^###\\s*technical\\s+todo"; "m")))
        then "technical-todo"
        elif (($labels | map(test("user\\s*story|type/feature|enhancement|feature\\s*request")) | any)
              or ($body | test("^###\\s*user\\s+story"; "m")))
        then "user-story"
        else "unknown"
        end;
    def labels: [(.labels // [])[] | (.name // "" | ascii_downcase)];
    def text: ((.title // "") + " " + (.body // "")) | ascii_downcase;
    def has_label($re): (labels | map(test($re)) | any);
    def has_text($re): (text | test($re));
    def section_line($heading):
      ((.body // "") | split("\n")) as $lines
      | ([range(0; ($lines | length))
          | select(
              ($lines[.] | ascii_downcase | gsub("\\s+"; " "))
              | test("^###\\s*" + $heading + "\\s*$")
            )
        ] | .[0]) as $idx
      | if $idx == null then null else
          (
            $lines[($idx + 1):]
            | map(gsub("\\r"; "") | gsub("^\\s+|\\s+$"; ""))
            | map(select(length > 0))
            | map(select((test("^###\\s")) | not))
            | map(select((ascii_downcase | test("^<img\\b|^!\\[|^no response$|^n/?a$|^->\\s*not fixed$|^see\\s*:")) | not))
            | .[0] // null
          )
        end;
    def body_line:
      (
        section_line("actual behaviou?r")
        // section_line("description")
        // section_line("expected behaviou?r")
        // (
          (.body // "")
          | split("\n")
          | map(gsub("\\r"; "") | gsub("^\\s+|\\s+$"; ""))
          | map(select(length > 0))
          | map(select((test("^###\\s")) | not))
          | map(select((ascii_downcase | test("^<img\\b|^!\\[|^no response$|^n/?a$|^->\\s*not fixed$|^see\\s*:")) | not))
          | .[0] // null
        )
      );
    def summary:
      ((.title // "") | gsub("\\s+"; " ")) as $title
      | (body_line // "") as $line
      | (
          if ($line | length) == 0 then $title
          elif ($title | length) == 0 then $line
          elif (($line | ascii_downcase) == ($title | ascii_downcase)) then $title
          elif ($line | ascii_downcase | startswith($title | ascii_downcase)) then $line
          else ($title + " - " + $line)
          end
        )
      | gsub("\\s+"; " ")
      | .[0:220];
    def age_days: ((now - (.created_at | fromdateiso8601)) / 86400 | floor);
    def stale_days: ((now - (.updated_at | fromdateiso8601)) / 86400 | floor);
    def has_section($heading): ((section_line($heading) // "") | length) > 0;
    def repro_quality_score:
      if has_section("how to reproduce\\??|steps to reproduce")
           and has_section("actual behaviou?r|description")
           and has_section("expected behaviou?r")
      then 3
      elif has_section("how to reproduce\\??|steps to reproduce")
           or has_text("stack trace|sqlstate|exception|traceback|\\b500\\b|\\b404\\b|error code")
      then 2
      elif has_text("cannot reproduce|can't reproduce|unknown|no steps|insufficient info|no repro|needs more information")
      then 0
      else 1
      end;
    def uncertainty_score:
      if has_text("cannot reproduce|can't reproduce|unknown|no steps|insufficient info|no repro|needs more information")
      then 3
      elif repro_quality_score >= 2
      then 0
      else 1
      end;
    def blast_radius_score:
      if has_text("outage|storefront down|cannot checkout|cannot place order|all customers|all orders|all products|every request")
      then 4
      elif has_text("checkout|payment|order|cart|login|search|listing|product detail|store api")
      then 3
      elif has_text("admin|backoffice|rule builder|flow builder|import|export")
      then 2
      else 1
      end;
    def business_criticality_score:
      if has_label("security|data loss|blocker|critical|sev1")
           or has_text("security|data loss|payment|checkout|cannot order|revenue|order fails")
      then 4
      elif has_label("priority/high|sev2|major")
           or has_text("order|cart|login|search|listing|product detail")
      then 3
      elif has_label("priority/medium")
           or has_text("admin|configuration|ux")
      then 2
      else 1
      end;
    def data_risk_score:
      if has_text("data loss|deleted|deletes|corrupt|integrity|leak|exposed")
      then 3
      elif has_text("migration|schema|foreign key|constraint|on delete|backward compatibility|bc break")
      then 2
      else 0
      end;
    def regression_score:
      if has_label("regression")
           or has_text("regression|after update|after upgrade|worked before|since\\s+[0-9]+\\.[0-9]+")
      then 2
      else 0
      end;
    def engagement_score:
      (
        (if (.comments // 0) >= 20 then 2 elif (.comments // 0) >= 8 then 1 else 0 end)
        + (if ((.reactions["+1"] // 0) >= 15) then 2 elif ((.reactions["+1"] // 0) >= 5) then 1 else 0 end)
      );
    def urgency_score:
      if age_days >= 180 then 3
      elif age_days >= 90 then 2
      elif stale_days >= 45 then 1
      else 0
      end;
    def impact_score: (blast_radius_score + business_criticality_score + data_risk_score + regression_score);
    def impact_reason:
      (
        [
          (if blast_radius_score >= 4 then "wide blast radius (core customer journey may be blocked)"
           elif blast_radius_score == 3 then "storefront/customer-facing impact"
           elif blast_radius_score == 2 then "admin/backoffice impact"
           else "localized impact" end),
          (if business_criticality_score >= 4 then "high business criticality (revenue/security/data-safety path)"
           elif business_criticality_score == 3 then "important commerce flow impact"
           else "" end),
          (if data_risk_score >= 3 then "possible data safety risk"
           elif data_risk_score >= 2 then "schema/compatibility risk"
           else "" end),
          (if regression_score > 0 then "regression signal present" else "" end)
        ]
        | map(select(length > 0))
        | join("; ")
      );
    def severity_score:
      (impact_score + (if engagement_score >= 2 then 1 else 0 end) - (if uncertainty_score >= 2 then 1 else 0 end));
    def severity:
      if severity_score >= 10 then "critical"
      elif severity_score >= 7 then "high"
      elif severity_score >= 4 then "medium"
      else "low"
      end;
    def surface_area_score:
      if has_text("cross[- ]module|multiple modules|plugin and core|app and core|end to end")
      then 3
      elif has_text("sales channel|store api|admin api|indexer|product export|product stream")
      then 2
      elif has_text("criteria|filter|condition|validation|mapping")
      then 1
      else 0
      end;
    def logic_complexity_score:
      if has_label("refactor|architecture|breaking|epic|technical debt")
           or has_text("refactor|architecture|rewrite|state machine|workflow|deep change")
      then 3
      elif has_text("intermittent|race|async|queue|worker|cache|state")
      then 2
      elif has_text("condition|validation|mapping|query|criteria|filter|association")
      then 1
      else 0
      end;
    def dependency_risk_score:
      if has_text("migration|schema|foreign key|constraint|index|backward compatibility|bc break|on delete")
           or has_label("breaking|migration")
      then 3
      elif has_text("api contract|public api|event subscriber|decorator")
      then 2
      elif has_text("plugin|app conflict|extension compatibility")
      then 1
      else 0
      end;
    def test_burden_score:
      if has_text("regression|intermittent|race|async|queue|worker|cache|state")
      then 2
      elif (.comments // 0) >= 8
      then 1
      else 0
      end;
    def unknowns_score: uncertainty_score;
    def easy_signal_score: (if has_label("good first issue|easy|small|trivial") then -2 else 0 end);
    def effort_score:
      (
        surface_area_score
        + logic_complexity_score
        + dependency_risk_score
        + test_burden_score
        + unknowns_score
        + easy_signal_score
      );
    def effort:
      if effort_score <= 4 then "easy"
      elif effort_score <= 8 then "medium"
      else "hard"
      end;
    def effort_confidence:
      if unknowns_score >= 2
        then "low"
      elif repro_quality_score >= 2 and unknowns_score == 0
        then "high"
      else "medium"
      end;
    def effort_reason:
      (
        [
          (if surface_area_score >= 3
            then "cross-module impact"
            elif surface_area_score == 2
            then "single-domain/service touch"
            else "" end),
          (if logic_complexity_score >= 3
            then "complex logic/refactor signals"
            elif logic_complexity_score >= 1
            then "targeted logic change"
            else "" end),
          (if dependency_risk_score >= 3
            then "schema/contract risk"
            elif dependency_risk_score >= 1
            then "integration/API risk"
            else "" end),
          (if test_burden_score >= 2
            then "higher validation burden"
            elif test_burden_score == 1
            then "discussion suggests non-trivial validation"
            else "" end),
          (if unknowns_score >= 2
            then "missing/unclear reproduction details"
            elif unknowns_score == 0
            then "clear reproduction details"
            else "partial reproduction details" end),
          (if easy_signal_score < 0
            then "easy-label signal"
            else "" end)
        ]
        | map(select(length > 0))
        | join("; ")
      );
    def effort_breakdown:
      {
        surface_area: surface_area_score,
        logic_complexity: logic_complexity_score,
        dependency_risk: dependency_risk_score,
        test_burden: test_burden_score,
        unknowns: unknowns_score,
        easy_signal: easy_signal_score,
        total: effort_score
      };
    def triage_confidence:
      if uncertainty_score >= 2 then "low"
      elif repro_quality_score >= 2 then "high"
      else "medium"
      end;
    def missing_info:
      (
        [
          (if has_section("how to reproduce\\??|steps to reproduce") then "" else "missing reproduction steps" end),
          (if has_section("expected behaviou?r") then "" else "missing expected behavior" end),
          (if has_section("actual behaviou?r|description") then "" else "missing concrete symptom details" end)
        ]
        | map(select(length > 0))
      );

    . as $i
    | {
        repo: ($i.repository_url | split("/") | .[-2] + "/" + .[-1]),
        number: $i.number,
        title: ($i.title // ""),
        url: ($i.html_url // ""),
        state: ($i.state // ""),
        created_at: ($i.created_at // ""),
        updated_at: ($i.updated_at // ""),
        author: ($i.user.login // ""),
        ticket_type: ticket_type,
        labels: [($i.labels // [])[] | .name],
        summary: summary,
        impact_score: impact_score,
        impact_reason: impact_reason,
        repro_quality_score: repro_quality_score,
        uncertainty_score: uncertainty_score,
        severity_score: severity_score,
        severity: severity,
        effort_score: effort_score,
        effort: effort,
        effort_confidence: effort_confidence,
        effort_reason: effort_reason,
        effort_breakdown: effort_breakdown,
        engagement_score: engagement_score,
        urgency_score: urgency_score,
        triage_confidence: triage_confidence,
        triage_status: (if uncertainty_score >= 2 then "needs-info" else "ready" end),
        missing_info: missing_info,
        comments: ($i.comments // 0),
        thumbs_up: ($i.reactions["+1"] // 0),
        participants: "n/a",
        age_days: age_days,
        stale_days: stale_days
      }
    | .priority_score = ((.severity_score * 3) + (.engagement_score * 2) + .urgency_score + (if .effort == "easy" and .severity != "low" then 2 else 0 end) - .uncertainty_score)
    | .priority_reason = (
        [
          (.impact_reason // ""),
          (if .comments >= 20 then (.comments|tostring) + " comments (heavy discussion)"
           elif .comments >= 8 then (.comments|tostring) + " comments (active discussion)"
           elif .comments >= 3 then (.comments|tostring) + " comments"
           else "" end),
          (if .thumbs_up >= 15 then (.thumbs_up|tostring) + " +1 reactions (strong demand)"
           elif .thumbs_up >= 5 then (.thumbs_up|tostring) + " +1 reactions (moderate demand)"
           elif .thumbs_up >= 1 then (.thumbs_up|tostring) + " +1 reactions"
           else "" end),
          (if .age_days >= 180 then "very stale (" + (.age_days|tostring) + "d old)"
           elif .age_days >= 90 then "stale (" + (.age_days|tostring) + "d old)"
           else "" end),
          (if .effort == "easy" and (.severity == "critical" or .severity == "high" or .severity == "medium")
           then "quick-win candidate"
           else "" end)
          ,
          (if .triage_status == "needs-info" then "confidence reduced: missing diagnostic details" else "" end)
        ]
        | map(select(length > 0))
        | if length == 0
          then "baseline priority from impact, urgency, and demand"
          else join("; ")
          end
      )
    | .triage_hint = (
        if .triage_status == "needs-info"
          then "Needs-info: ask for reproducible steps/environment before committing engineering capacity."
        elif (.effort == "easy" and (.severity == "critical" or .severity == "high" or .severity == "medium"))
          then "Quick win: low effort with meaningful impact."
        elif (.comments >= 20 or .thumbs_up >= 15)
          then "Community pressure: many users are engaged."
        elif (.age_days >= 120)
          then "Stale risk: long-open issue should be revisited."
        elif (.severity == "critical")
          then "Urgent: likely broad impact."
        elif (.severity == "high")
          then "Important: high impact; prioritize soon."
        else
          "Normal triage flow."
        end
      )
]
| if $ticket_type == "all"
  then .
  else map(select(.ticket_type == $ticket_type))
  end
| sort_by(-.priority_score, .number)
JQ
}

severity_from_score() {
  local score="$1"
  if (( score >= 10 )); then
    echo "critical"
  elif (( score >= 7 )); then
    echo "high"
  elif (( score >= 4 )); then
    echo "medium"
  else
    echo "low"
  fi
}

effort_from_score() {
  local score="$1"
  if (( score <= 4 )); then
    echo "easy"
  elif (( score >= 9 )); then
    echo "hard"
  else
    echo "medium"
  fi
}

print_table() {
  local json="$1"
  echo "| # | Severity | Effort | Age(d) | Comments | +1 | Participants | Priority | Title |"
  echo "|---|---|---:|---:|---:|---:|---:|---:|---|"
  jq -r '.[] | "| #\(.number) | \(.severity) | \(.effort) | \(.age_days) | \(.comments) | \(.thumbs_up) | \(.participants) | \(.priority_score) | \(.title | gsub("\\|"; "/") | .[0:90]) |"' <<< "$json"
}

print_issue_details() {
  local json="$1"
  echo
  echo "### Issue Summaries"
  jq -r '.[] | "- #\(.number): \(.summary)\n  - severity: \(.severity), effort: \(.effort), age: \(.age_days)d, comments: \(.comments), +1: \(.thumbs_up), participants: \(.participants)\n  - url: \(.url)"' <<< "$json"
}

collect_issues_from_list_mode() {
  local repo="$1"
  local state="$2"
  local labels="$3"
  local limit="$4"
  local page=1
  local total_count=0
  local tmp_file

  tmp_file="$(mktemp)"

  while :; do
    local page_json filtered page_count
    if [[ -n "$labels" ]]; then
      if ! page_json="$(gh_api_json_retry --method GET "repos/$repo/issues" -f state="$state" -f labels="$labels" -f per_page=100 -f page="$page")"; then
        echo "error: failed to fetch issues for $repo (page $page)." >&2
        exit 1
      fi
    elif ! page_json="$(gh_api_json_retry --method GET "repos/$repo/issues" -f state="$state" -f per_page=100 -f page="$page")"; then
      echo "error: failed to fetch issues for $repo (page $page)." >&2
      exit 1
    fi
    filtered="$(jq -c '.[] | select(.pull_request | not)' <<< "$page_json")"
    if [[ -n "$filtered" ]]; then
      printf '%s\n' "$filtered" >> "$tmp_file"
      page_count="$(grep -c . <<< "$filtered" | tr -d ' ')"
      total_count=$((total_count + page_count))
    else
      page_count=0
    fi

    if (( page_count < 100 || total_count >= limit )); then
      break
    fi

    page=$((page + 1))
  done

  if [[ ! -s "$tmp_file" ]]; then
    rm -f "$tmp_file"
    echo '[]'
    return
  fi

  jq -s --argjson lim "$limit" '.[0:$lim]' "$tmp_file"
  rm -f "$tmp_file"
}

collect_issues_from_refs() {
  local refs_csv="$1"
  local default_repo="$2"
  local labels_csv="$3"
  local tmp_file
  local -a label_terms=()

  tmp_file="$(mktemp)"

  if [[ -n "$labels_csv" ]]; then
    IFS=',' read -r -a label_terms <<< "$labels_csv"
  fi
  IFS=',' read -r -a refs <<< "$refs_csv"
  for raw in "${refs[@]}"; do
    local ref parsed repo number item
    ref="$(trim "$raw")"
    if [[ -z "$ref" ]]; then
      continue
    fi

    parsed="$(parse_issue_ref "$ref" "$default_repo")"
    read -r repo number <<< "$parsed"

    if [[ -n "$REPO" && "$repo" != "$REPO" ]]; then
      echo "error: mixed repositories are not supported in one run ($REPO vs $repo)." >&2
      exit 1
    fi

    REPO="$repo"
    if ! item="$(gh_api_json_retry "repos/$repo/issues/$number")"; then
      echo "error: failed to fetch issue #$number from $repo." >&2
      exit 1
    fi

    if jq -e '.pull_request' >/dev/null 2>&1 <<< "$item"; then
      echo "warning: skipping pull request ref #$number in $repo" >&2
      continue
    fi

    if (( ${#label_terms[@]} > 0 )); then
      local matched=0
      local normalized_labels
      normalized_labels="$(jq -r '[.labels[]?.name // ""] | map(ascii_downcase) | join("\n")' <<< "$item")"
      for term in "${label_terms[@]}"; do
        local t
        t="$(trim "$term")"
        if [[ -z "$t" ]]; then
          continue
        fi
        if grep -Fqx -- "$(tr '[:upper:]' '[:lower:]' <<< "$t")" <<< "$normalized_labels"; then
          matched=1
          break
        fi
      done
      if (( matched == 0 )); then
        continue
      fi
    fi

    printf '%s\n' "$(jq -c '.' <<< "$item")" >> "$tmp_file"
  done

  if [[ ! -s "$tmp_file" ]]; then
    rm -f "$tmp_file"
    echo '[]'
    return
  fi

  jq -s '.' "$tmp_file"
  rm -f "$tmp_file"
}

deep_enrich() {
  local repo="$1"
  local json="$2"
  local comments_limit="$3"
  local tmp_file

  tmp_file="$(mktemp)"

  while IFS= read -r row; do
    local obj number author comment_count base_sev base_eff base_unc comments_pages participants recent_comments lowered
    local comment_sev comment_hard comment_easy comment_unknown adj_sev adj_eff adj_unc sev_level eff_level updated

    obj="$(decode_b64 "$row")"
    number="$(jq -r '.number' <<< "$obj")"
    author="$(jq -r '.author' <<< "$obj")"
    comment_count="$(jq -r '.comments // 0' <<< "$obj")"
    base_sev="$(jq -r '.severity_score' <<< "$obj")"
    base_eff="$(jq -r '.effort_score' <<< "$obj")"
    base_unc="$(jq -r '.uncertainty_score // 1' <<< "$obj")"

    if (( comment_count == 0 )); then
      comments_pages='[]'
    elif ! comments_pages="$(gh_api_json_retry "repos/$repo/issues/$number/comments" --paginate --slurp)"; then
      echo "warning: failed to fetch comments for #$number in $repo; using metadata-only deep triage." >&2
      comments_pages='[]'
    fi
    participants="$(jq --arg author "$author" '[.[ ][] | .user.login // empty] + [$author] | map(select(length > 0)) | unique | length' <<< "$comments_pages")"
    recent_comments="$(jq --argjson lim "$comments_limit" '[.[ ][] | .body // ""] | if length > $lim then .[-$lim:] else . end | join("\n")' <<< "$comments_pages")"

    lowered="$(tr '[:upper:]' '[:lower:]' <<< "$recent_comments")"
    comment_sev="$({ grep -Eo 'critical|blocker|regression|urgent|security|data loss|broken|cannot|workaround' <<< "$lowered" || true; } | wc -l | tr -d ' ')"
    comment_hard="$({ grep -Eo 'complex|refactor|deep change|cross-module|architecture|breaking' <<< "$lowered" || true; } | wc -l | tr -d ' ')"
    comment_easy="$({ grep -Eo 'simple|quick fix|one line|small change|easy fix' <<< "$lowered" || true; } | wc -l | tr -d ' ')"
    comment_unknown="$({ grep -Eo 'cannot reproduce|can.t reproduce|no steps|insufficient info|needs more info|need more info' <<< "$lowered" || true; } | wc -l | tr -d ' ')"

    adj_sev="$base_sev"
    if (( comment_sev >= 3 )); then
      adj_sev=$((adj_sev + 2))
    elif (( comment_sev >= 1 )); then
      adj_sev=$((adj_sev + 1))
    fi

    adj_eff=$((base_eff + comment_hard - comment_easy))
    adj_unc="$base_unc"
    if (( comment_unknown >= 2 )); then
      adj_unc=$((adj_unc + 1))
    fi
    if (( adj_unc < 0 )); then
      adj_unc=0
    elif (( adj_unc > 3 )); then
      adj_unc=3
    fi
    sev_level="$(severity_from_score "$adj_sev")"
    eff_level="$(effort_from_score "$adj_eff")"

    updated="$(jq -c \
      --arg severity "$sev_level" \
      --arg effort "$eff_level" \
      --argjson severity_score "$adj_sev" \
      --argjson effort_score "$adj_eff" \
      --argjson uncertainty_score "$adj_unc" \
      --argjson participants "$participants" \
      --argjson comment_hard "$comment_hard" \
      --argjson comment_easy "$comment_easy" \
      --argjson comment_unknown "$comment_unknown" \
      '.severity = $severity
       | .severity_score = $severity_score
       | .effort = $effort
       | .effort_score = $effort_score
       | .uncertainty_score = $uncertainty_score
       | .effort_breakdown.total = .effort_score
       | .effort_breakdown.unknowns = $uncertainty_score
       | .effort_reason = (
           (.effort_reason // "heuristic effort assessment")
           + (if $comment_hard >= 2 then "; comment thread shows additional complexity" else "" end)
           + (if $comment_easy >= 2 then "; comment thread suggests smaller implementation scope" else "" end)
           + (if $comment_unknown >= 2 then "; diagnostic details in comments are still incomplete" else "" end)
         )
       | .effort_confidence = (
           if (.effort_breakdown.unknowns // 0) >= 2 then "low"
           elif (.repro_quality_score // 0) >= 2 and (.effort_breakdown.unknowns // 0) == 0 then "high"
           else "medium"
           end
         )
       | .triage_confidence = (
           if ($uncertainty_score >= 2) then "low"
           elif (.repro_quality_score // 0) >= 2 then "high"
           else "medium"
           end
         )
       | .triage_status = (if $uncertainty_score >= 2 then "needs-info" else "ready" end)
       | .participants = $participants
       | .engagement_score = (
           (if .comments >= 20 then 2 elif .comments >= 8 then 1 else 0 end)
           + (if .thumbs_up >= 15 then 2 elif .thumbs_up >= 5 then 1 else 0 end)
           + (if $participants >= 10 then 1 else 0 end)
         )
       | .priority_score = ((.severity_score * 3) + (.engagement_score * 2) + .urgency_score + (if .effort == "easy" and .severity != "low" then 2 else 0 end) - .uncertainty_score)
       | .priority_reason = (
           [
             (.impact_reason // ""),
             (if .comments >= 20 then (.comments|tostring) + " comments (heavy discussion)"
              elif .comments >= 8 then (.comments|tostring) + " comments (active discussion)"
              elif .comments >= 3 then (.comments|tostring) + " comments"
              else "" end),
             (if .thumbs_up >= 15 then (.thumbs_up|tostring) + " +1 reactions (strong demand)"
              elif .thumbs_up >= 5 then (.thumbs_up|tostring) + " +1 reactions (moderate demand)"
              elif .thumbs_up >= 1 then (.thumbs_up|tostring) + " +1 reactions"
              else "" end),
             (if $participants >= 10 then ($participants|tostring) + " participants (broad involvement)"
              elif $participants >= 5 then ($participants|tostring) + " participants"
              else "" end),
             (if .age_days >= 180 then "very stale (" + (.age_days|tostring) + "d old)"
              elif .age_days >= 90 then "stale (" + (.age_days|tostring) + "d old)"
              else "" end),
             (if .effort == "easy" and (.severity == "critical" or .severity == "high" or .severity == "medium")
              then "quick-win candidate"
              else "" end)
             ,
             (if .triage_status == "needs-info" then "confidence reduced: missing diagnostic details" else "" end)
           ]
           | map(select(length > 0))
           | if length == 0
             then "baseline priority from impact, urgency, and demand"
             else join("; ")
             end
         )
       | .triage_hint = (
           if .triage_status == "needs-info"
             then "Needs-info: ask for reproducible steps/environment before committing engineering capacity."
           elif (.effort == "easy" and (.severity == "critical" or .severity == "high" or .severity == "medium"))
             then "Quick win: low effort with meaningful impact."
           elif (.comments >= 20 or .thumbs_up >= 15)
             then "Community pressure: many users are engaged."
           elif (.age_days >= 120)
             then "Stale risk: long-open issue should be revisited."
           elif (.severity == "critical")
             then "Urgent: likely broad impact."
           elif (.severity == "high")
             then "Important: high impact; prioritize soon."
           else
             "Normal triage flow."
           end
         )
      ' <<< "$obj")"

    printf '%s\n' "$updated" >> "$tmp_file"
  done < <(jq -r '.[] | @base64' <<< "$json")

  if [[ ! -s "$tmp_file" ]]; then
    rm -f "$tmp_file"
    echo '[]'
    return
  fi

  jq -s 'sort_by(-.priority_score, .number)' "$tmp_file"
  rm -f "$tmp_file"
}

if [[ -n "$ISSUE_CSV" ]]; then
  issues_raw="$(collect_issues_from_refs "$ISSUE_CSV" "$REPO" "$LABEL_FILTER")"
else
  if [[ -z "$REPO" ]]; then
    echo "error: --repo is required when --issues is not provided." >&2
    exit 1
  fi
  issues_raw="$(collect_issues_from_list_mode "$REPO" "$STATE" "$LABEL_FILTER" "$LIMIT")"
fi

total_issues="$(jq 'length' <<< "$issues_raw")"
if (( total_issues == 0 )); then
  if [[ "$OUTPUT_FORMAT" == "json" ]]; then
    jq -n \
      --arg repo "${REPO:-mixed-from-refs}" \
      --arg mode "$MODE" \
      --arg ticket_type "$TICKET_TYPE" \
      --arg label_filter "${LABEL_FILTER:-none}" \
      '{
        repo: $repo,
        mode: $mode,
        ticket_type: $ticket_type,
        label_filter: $label_filter,
        issues_fetched: 0,
        issues_scanned: 0,
        issues: []
      }'
    exit 0
  fi
  echo "No issues found for the given input."
  exit 0
fi

light_triage="$(jq --arg ticket_type "$TICKET_TYPE" "$(triage_filter_jq)" <<< "$issues_raw")"
total_selected="$(jq 'length' <<< "$light_triage")"
if (( total_selected == 0 )); then
  if [[ "$OUTPUT_FORMAT" == "json" ]]; then
    jq -n \
      --arg repo "${REPO:-mixed-from-refs}" \
      --arg mode "$MODE" \
      --arg ticket_type "$TICKET_TYPE" \
      --arg label_filter "${LABEL_FILTER:-none}" \
      --argjson fetched "$total_issues" \
      '{
        repo: $repo,
        mode: $mode,
        ticket_type: $ticket_type,
        label_filter: $label_filter,
        issues_fetched: $fetched,
        issues_scanned: 0,
        issues: []
      }'
    exit 0
  fi
  echo "No issues found for the given input."
  exit 0
fi

if [[ "$OUTPUT_FORMAT" == "json" && "$MODE" == "light" ]]; then
  jq -n \
    --arg repo "${REPO:-mixed-from-refs}" \
    --arg mode "$MODE" \
    --arg ticket_type "$TICKET_TYPE" \
    --arg label_filter "${LABEL_FILTER:-none}" \
    --argjson fetched "$total_issues" \
    --argjson scanned "$total_selected" \
    --argjson issues "$light_triage" \
    '{
      repo: $repo,
      mode: $mode,
      ticket_type: $ticket_type,
      label_filter: $label_filter,
      issues_fetched: $fetched,
      issues_scanned: $scanned,
      issues: $issues
    }'
  exit 0
fi

if [[ "$OUTPUT_FORMAT" != "json" ]]; then
  echo "## Issue Triage"
  echo "repo: ${REPO:-mixed-from-refs}"
  echo "mode: $MODE"
  echo "ticket_type: $TICKET_TYPE"
  echo "label_filter: ${LABEL_FILTER:-none}"
  echo "issues_fetched: $total_issues"
  echo "issues_scanned: $total_selected"
  echo
fi

if [[ "$MODE" == "light" ]]; then
  print_table "$light_triage"
  if (( total_selected <= 5 )); then
    print_issue_details "$light_triage"
  fi
  exit 0
fi

if [[ -n "$ISSUE_CSV" ]]; then
  selected="$light_triage"
else
  selected="$(jq --argjson top "$TOP_N" '.[0:$top]' <<< "$light_triage")"
fi

selected_count="$(jq 'length' <<< "$selected")"
if [[ "$OUTPUT_FORMAT" != "json" ]]; then
  echo "issues_deep_analyzed: $selected_count"
  echo
fi

deep_triage="$(deep_enrich "$REPO" "$selected" "$COMMENT_LIMIT")"

if [[ "$OUTPUT_FORMAT" == "json" ]]; then
  jq -n \
    --arg repo "${REPO:-mixed-from-refs}" \
    --arg mode "$MODE" \
    --arg ticket_type "$TICKET_TYPE" \
    --arg label_filter "${LABEL_FILTER:-none}" \
    --argjson fetched "$total_issues" \
    --argjson scanned "$total_selected" \
    --argjson deep_analyzed "$selected_count" \
    --argjson issues "$deep_triage" \
    '{
      repo: $repo,
      mode: $mode,
      ticket_type: $ticket_type,
      label_filter: $label_filter,
      issues_fetched: $fetched,
      issues_scanned: $scanned,
      issues_deep_analyzed: $deep_analyzed,
      issues: $issues
    }'
  exit 0
fi

print_table "$deep_triage"

if (( selected_count <= 10 )); then
  print_issue_details "$deep_triage"
fi

if [[ -z "$ISSUE_CSV" && "$selected_count" -lt "$total_issues" ]]; then
  echo
  echo "Note: deep mode analyzed top $selected_count issues only; use --top to change this."
fi
