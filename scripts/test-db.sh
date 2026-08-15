#!/usr/bin/env bash
# Throwaway local Postgres for the test suite.
#
# Creates a cluster inside .tmp-testdb/ (gitignored), listening on a
# non-default port so it can never be confused with a real local Postgres, and
# never with the hosted production database. Everything in it is disposable:
# `stop` leaves the data, `destroy` deletes the whole cluster.
#
# Usage:
#   scripts/test-db.sh start     # init if needed, start, create naseeb_test
#   scripts/test-db.sh stop
#   scripts/test-db.sh destroy
#   scripts/test-db.sh url       # print the connection URL
#
# Then:
#   export TEST_DATABASE_URL="$(scripts/test-db.sh url)"
#   npm test

set -euo pipefail

PORT="${TEST_DB_PORT:-55432}"
DB_NAME="naseeb_test"
DB_USER="postgres"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_DIR="${REPO_ROOT}/.tmp-testdb"
DATA_DIR="${CLUSTER_DIR}/data"
SOCKET_DIR="${CLUSTER_DIR}/run"
LOG_FILE="${CLUSTER_DIR}/postgres.log"

# Debian/Ubuntu keep the server binaries out of PATH (only the client is
# linked), so look there before giving up.
find_bin_dir() {
  if command -v pg_ctl >/dev/null 2>&1 && command -v initdb >/dev/null 2>&1; then
    dirname "$(command -v pg_ctl)"
    return
  fi
  local candidate
  candidate=$(ls -d /usr/lib/postgresql/*/bin /usr/local/pgsql/bin 2>/dev/null | sort -V | tail -1 || true)
  if [ -n "${candidate}" ] && [ -x "${candidate}/pg_ctl" ]; then
    echo "${candidate}"
    return
  fi
  echo "Could not find the PostgreSQL server binaries (initdb/pg_ctl)." >&2
  echo "Install a PostgreSQL server package, or set TEST_DATABASE_URL to your own test database." >&2
  exit 1
}

BIN_DIR="$(find_bin_dir)"

# initdb and postgres refuse to run as root. When this script is run as root
# (containers, CI images), drop to the postgres system user instead of failing.
RUN_AS=""
if [ "$(id -u)" -eq 0 ]; then
  if id postgres >/dev/null 2>&1; then
    RUN_AS="postgres"
  else
    echo "Running as root and no 'postgres' system user exists — PostgreSQL will not start as root." >&2
    exit 1
  fi
fi

as_pg() {
  if [ -n "${RUN_AS}" ]; then
    su "${RUN_AS}" -c "$*"
  else
    bash -c "$*"
  fi
}

url() {
  echo "postgresql://${DB_USER}@127.0.0.1:${PORT}/${DB_NAME}"
}

start() {
  mkdir -p "${DATA_DIR}" "${SOCKET_DIR}"
  if [ -n "${RUN_AS}" ]; then
    chown -R "${RUN_AS}" "${CLUSTER_DIR}"
    chmod 755 "${CLUSTER_DIR}"
  fi

  if [ ! -f "${DATA_DIR}/PG_VERSION" ]; then
    echo "Initialising throwaway cluster in ${DATA_DIR} ..."
    # -A trust is safe here and only here: the cluster listens on loopback, on
    # a non-default port, and holds nothing but disposable test fixtures.
    as_pg "${BIN_DIR}/initdb -D '${DATA_DIR}' -U '${DB_USER}' -A trust" >/dev/null
  fi

  if as_pg "${BIN_DIR}/pg_ctl -D '${DATA_DIR}' status" >/dev/null 2>&1; then
    echo "Already running on port ${PORT}."
  else
    as_pg "${BIN_DIR}/pg_ctl -D '${DATA_DIR}' \
      -o '-p ${PORT} -k ${SOCKET_DIR} -c listen_addresses=127.0.0.1' \
      -l '${LOG_FILE}' start" >/dev/null
    echo "Started on port ${PORT}."
  fi

  for _ in $(seq 1 30); do
    if "${BIN_DIR}/pg_isready" -h 127.0.0.1 -p "${PORT}" -U "${DB_USER}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  if ! "${BIN_DIR}/psql" -h 127.0.0.1 -p "${PORT}" -U "${DB_USER}" -lqt \
      | cut -d '|' -f1 | grep -qw "${DB_NAME}"; then
    "${BIN_DIR}/createdb" -h 127.0.0.1 -p "${PORT}" -U "${DB_USER}" "${DB_NAME}"
    echo "Created database ${DB_NAME}."
  fi

  echo
  echo "  export TEST_DATABASE_URL=\"$(url)\""
  echo "  npm test"
}

stop() {
  if [ -f "${DATA_DIR}/PG_VERSION" ] && as_pg "${BIN_DIR}/pg_ctl -D '${DATA_DIR}' status" >/dev/null 2>&1; then
    as_pg "${BIN_DIR}/pg_ctl -D '${DATA_DIR}' -m fast stop" >/dev/null
    echo "Stopped."
  else
    echo "Not running."
  fi
}

destroy() {
  stop || true
  rm -rf "${CLUSTER_DIR}"
  echo "Removed ${CLUSTER_DIR}."
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  destroy) destroy ;;
  url) url ;;
  *)
    echo "Usage: $0 {start|stop|destroy|url}" >&2
    exit 1
    ;;
esac
