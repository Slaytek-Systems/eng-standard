# shellcheck shell=bash
# Self-merge's decision (scripts/pr-gate.mjs merge --dry-run, from the checkout under test) on a fake GitHub: the packed eng
# posts the verdict comments and run statuses into it, and the gate says WOULD MERGE only when every rule holds.
source "$(dirname "$0")/lib.sh"
SRC=$(cat "$PROJ/../src")
init_repo self-merge
expect 0 git remote add origin https://github.com/fake/repo.git
expect 0 sh -c 'git switch -qc feat && echo change > change.txt && git add change.txt && git commit -qm change'
BASE=$(S git rev-parse main) HEAD_SHA=$(S git rev-parse HEAD)
FAKEBIN=$PROJ/fake-gh-$$ GH_STATE=$PROJ/fake-gh-$$/state.json
mkdir -p "$FAKEBIN" && ln -s "$(dirname "$0")/fake-gh.mjs" "$FAKEBIN/gh"
export FAKEBIN GH_STATE GITHUB_REPOSITORY=fake/repo FAKE_GH_LOGIN=Mattslayga
GH_UNSET='-u GH_TOKEN -u GITHUB_TOKEN -u GH_HOST -u GH_REPO'
# gh_ <exit> <cmd...>: run it in the journey repo with the fake gh first on PATH.
gh_() { local want=$1; shift; expect "$want" env $GH_UNSET sh -c 'PATH="$FAKEBIN:$PATH" exec "$@"' sh "$@"; }
gate() { gh_ 0 node "$SRC/scripts/pr-gate.mjs" merge --pr 7 --dry-run; }
state() { node -e "const fs=require('fs'),f=process.env.GH_STATE,s=JSON.parse(fs.readFileSync(f,'utf8'));$1;fs.writeFileSync(f,JSON.stringify(s,null,2))"; }
snap() { cp "$GH_STATE" "$GH_STATE.$1"; }
back() { cp "$GH_STATE.$1" "$GH_STATE"; echo "-- state reset to $1"; }

cat > "$GH_STATE" <<EOF
{ "main": "$BASE", "behind": 0,
  "pulls": { "7": { "number": 7, "state": "open", "draft": false, "title": "change", "created_at": "2026-11-15T00:00:00Z",
    "changed_files": 1, "commits": 1, "labels": [{ "name": "risk:low" }],
    "base": { "ref": "main", "sha": "$BASE" }, "head": { "sha": "$HEAD_SHA", "ref": "feat", "repo": { "full_name": "fake/repo" } } } },
  "files": { "7": [{ "filename": "change.txt", "status": "added" }] },
  "checks": { "$BASE": "success", "$HEAD_SHA": "success" }, "statuses": {}, "comments": {}, "calls": [] }
EOF
snap fresh

gate
has 'skip'

gh_ 0 eng run --by v1 -- true
gh_ 0 eng verdict PASS --by v1 --pr 7
gate
has "#7 ${HEAD_SHA:0:8}: WOULD MERGE"
snap pass

state 's.pulls[7].labels.push({ name: "hold" })'
gate
has 'skip: hold label'
back pass

state 's.behind = 1'
gate
has 'does not contain main'"'"'s tip'
back pass

expect 0 sh -c 'echo again >> change.txt && git commit -qam again'
NEW=$(S git rev-parse HEAD)
state "s.pulls[7].head.sha='$NEW'; s.checks['$NEW']='success'; s.statuses['$NEW']=[{...s.statuses['$HEAD_SHA'].at(-1), id: ++s.nextStatus}]"
gate
has "stale verdicts (for ${HEAD_SHA:0:8}), none for head ${NEW:0:8}"
expect 0 git switch -q --detach "$HEAD_SHA"
back pass

back fresh
FAKE_GH_LOGIN=collab gh_ 0 eng run --by v2 -- true
FAKE_GH_LOGIN=collab gh_ 0 eng verdict PASS --by v2 --pr 7
gate
has "skip: no verdict comment for head ${HEAD_SHA:0:8}"
back pass

gh_ 1 eng run --by v1 -- false
gh_ 1 eng verdict FAIL --by v1 --pr 7
gate
has 'skip: verdict is failure on head'
state "s.statuses['$HEAD_SHA'].push({...s.statuses['$HEAD_SHA'].find(r => r.context === 'verdict' && r.state === 'success'), id: ++s.nextStatus})"
gate
has "skip: verdict FAIL by v1 on head ${HEAD_SHA:0:8} (its latest)"
back pass

gh_ 0 eng run --by v1 -- node "$SRC/scripts/pr-gate.mjs" merge --pr 7 --dry-run
has 'a run by v1 is still in progress'
gate
has "#7 ${HEAD_SHA:0:8}: WOULD MERGE"
back pass

DEAD=eng-run/v1/b5bea41b-deadbeef
state "const r = s.statuses['$HEAD_SHA'].find(r => r.state === 'pending'); s.statuses['$HEAD_SHA'].push({ ...r, id: ++s.nextStatus, context: '$DEAD', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })"
gate
has 'a run by v1 is still in progress'
FAKE_GH_LOGIN=collab gh_ 0 gh api "repos/fake/repo/statuses/$HEAD_SHA" -f state=success -f "context=$DEAD" -f 'description=eng run v1: finished, exit 0; not a merge check: true'
gate
has 'a run by v1 is still in progress'
gh_ 0 gh api "repos/fake/repo/statuses/$HEAD_SHA" -f state=error -f "context=$DEAD" -f 'description=cleared by hand: the run died'
gate
has "#7 ${HEAD_SHA:0:8}: WOULD MERGE"
back pass

state "const r = s.statuses['$HEAD_SHA'].find(r => r.state === 'pending'), t = new Date(Date.now() - 2106e3).toISOString(); s.statuses['$HEAD_SHA'].push({ ...r, id: ++s.nextStatus, context: '$DEAD', created_at: t, updated_at: t })"
gate
has "#7 ${HEAD_SHA:0:8}: WOULD MERGE"
state "for (const r of s.statuses['$HEAD_SHA']) if (r.context === '$DEAD') r.created_at = r.updated_at = new Date(Date.now() - 2094e3).toISOString()"
gate
has 'a run by v1 is still in progress'
back pass

state "s.statuses['$HEAD_SHA'].push({ ...s.statuses['$HEAD_SHA'][0], id: ++s.nextStatus, creator: null })"
gate
has "the statuses on head ${HEAD_SHA:0:8} cannot be read"
back pass

state "s.statuses['$HEAD_SHA'].push({ ...s.statuses['$HEAD_SHA'][0], id: ++s.nextStatus, context: 'eng-run/v1/zzz' })"
gate
has "the statuses on head ${HEAD_SHA:0:8} cannot be read"
back pass

expect 0 node -e "const c = require(process.env.GH_STATE).calls.filter(a => a.includes('PUT') || a.some(x => /\/merge$|dispatches|labels/.test(x))); if (c.length) { console.log(JSON.stringify(c)); process.exit(1) }"
echo "ok: the dry runs made no merge, dispatch or label call"
