package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// CopyReport is what CopyInto wrote: rows per table, and the tables it left out on purpose.
type CopyReport struct {
	Tables  map[string]int `json:"tables"`
	Skipped []string       `json:"skipped"`
}

// Tables CopyInto never copies: schema versions (each store has its own, checked equal instead) and
// the per-box heartbeat, which the destination's boxes write for themselves.
var copySkip = map[string]bool{"whatsmeow_version": true, "gw_boxes": true}

// CopyInto copies every row of src into dst (a box moving from SQLite to a shared Postgres store), in
// one destination transaction: either everything lands or nothing does. Both stores must be on the
// same schema version (same gateway build). A row that already exists in dst (same primary key) fails
// the whole copy rather than being overwritten, so it can't clobber another box's accounts. Run it
// with the gateway stopped: src must not change while it is read.
func CopyInto(ctx context.Context, src, dst *DB) (*CopyReport, error) {
	sv, err := schemaVersion(ctx, src)
	if err != nil {
		return nil, fmt.Errorf("source: %w", err)
	}
	dv, err := schemaVersion(ctx, dst)
	if err != nil {
		return nil, fmt.Errorf("destination: %w", err)
	}
	if sv != dv {
		return nil, fmt.Errorf("whatsmeow schema version differs (source %d, destination %d): use the same gateway build for both", sv, dv)
	}
	srcTables, err := tables(ctx, src)
	if err != nil {
		return nil, fmt.Errorf("source tables: %w", err)
	}
	dstTables, err := tables(ctx, dst)
	if err != nil {
		return nil, fmt.Errorf("destination tables: %w", err)
	}
	have := map[string]bool{}
	for _, t := range dstTables {
		have[t] = true
	}
	rep := &CopyReport{Tables: map[string]int{}}
	var todo []string
	for _, t := range srcTables {
		switch {
		case copySkip[t]:
			rep.Skipped = append(rep.Skipped, t)
		case !have[t]:
			return nil, fmt.Errorf("table %s is not in the destination schema", t)
		default:
			todo = append(todo, t)
		}
	}
	order, err := fkOrder(ctx, dst, todo)
	if err != nil {
		return nil, err
	}
	tx, err := dst.SQL.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	for _, t := range order {
		n, err := copyTable(ctx, src, dst, tx, t)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", t, err)
		}
		rep.Tables[t] = n
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	sort.Strings(rep.Skipped)
	return rep, nil
}

func schemaVersion(ctx context.Context, db *DB) (int, error) {
	var v int
	err := db.SQL.QueryRowContext(ctx, `SELECT version FROM whatsmeow_version`).Scan(&v)
	return v, err
}

func tables(ctx context.Context, db *DB) ([]string, error) {
	q := `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
	if db.Dialect == "postgres" {
		q = `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
	}
	rows, err := db.SQL.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	sort.Strings(out)
	return out, rows.Err()
}

// fkOrder sorts tables so a table comes after every table its foreign keys reference (in dst).
func fkOrder(ctx context.Context, dst *DB, ts []string) ([]string, error) {
	in := map[string]bool{}
	for _, t := range ts {
		in[t] = true
	}
	deps := map[string][]string{}
	if dst.Dialect == "postgres" {
		rows, err := dst.SQL.QueryContext(ctx, `
			SELECT c.conrelid::regclass::text, c.confrelid::regclass::text FROM pg_constraint c
			WHERE c.contype = 'f' AND c.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var from, to string
			if err := rows.Scan(&from, &to); err != nil {
				rows.Close()
				return nil, err
			}
			from, to = strings.Trim(from, `"`), strings.Trim(to, `"`)
			if from != to {
				deps[from] = append(deps[from], to)
			}
		}
		rows.Close()
	} else {
		for _, t := range ts {
			rows, err := dst.SQL.QueryContext(ctx, `SELECT "table" FROM pragma_foreign_key_list(?)`, t)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var to string
				if err := rows.Scan(&to); err != nil {
					rows.Close()
					return nil, err
				}
				if to != t {
					deps[t] = append(deps[t], to)
				}
			}
			rows.Close()
		}
	}
	var out []string
	state := map[string]int{} // 1 visiting, 2 done
	var visit func(string) error
	visit = func(t string) error {
		switch state[t] {
		case 1:
			return fmt.Errorf("foreign key cycle at %s", t)
		case 2:
			return nil
		}
		state[t] = 1
		for _, d := range deps[t] {
			if in[d] {
				if err := visit(d); err != nil {
					return err
				}
			}
		}
		state[t] = 2
		out = append(out, t)
		return nil
	}
	for _, t := range ts {
		if err := visit(t); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// columnTypes maps a destination table's columns to lower-case type names.
func columnTypes(ctx context.Context, tx *sql.Tx, dialect, t string) (map[string]string, error) {
	q, arg := `SELECT name, type FROM pragma_table_info(?)`, t
	if dialect == "postgres" {
		q = `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`
	}
	rows, err := tx.QueryContext(ctx, q, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var c, typ string
		if err := rows.Scan(&c, &typ); err != nil {
			return nil, err
		}
		out[c] = strings.ToLower(typ)
	}
	return out, rows.Err()
}

func quoteIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

func copyTable(ctx context.Context, src, dst *DB, tx *sql.Tx, t string) (int, error) {
	types, err := columnTypes(ctx, tx, dst.Dialect, t)
	if err != nil {
		return 0, err
	}
	rows, err := src.SQL.QueryContext(ctx, `SELECT * FROM `+quoteIdent(t))
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return 0, err
	}
	colTypes := make([]string, len(cols))
	quoted := make([]string, len(cols))
	for i, c := range cols {
		typ, ok := types[c]
		if !ok {
			return 0, fmt.Errorf("column %s is not in the destination", c)
		}
		colTypes[i], quoted[i] = typ, quoteIdent(c)
	}
	// Stay well under Postgres' 65,535 bind parameters per statement.
	per := 20000 / len(cols)
	if per < 1 {
		per = 1
	}
	if per > 500 {
		per = 500
	}
	var batch []any
	n, inBatch := 0, 0
	flush := func() error {
		if inBatch == 0 {
			return nil
		}
		var sb strings.Builder
		sb.WriteString("INSERT INTO " + quoteIdent(t) + " (" + strings.Join(quoted, ", ") + ") VALUES ")
		p := 0
		for r := 0; r < inBatch; r++ {
			if r > 0 {
				sb.WriteString(", ")
			}
			sb.WriteByte('(')
			for c := range cols {
				if c > 0 {
					sb.WriteString(", ")
				}
				p++
				if dst.Dialect == "postgres" {
					sb.WriteString("$" + strconv.Itoa(p))
				} else {
					sb.WriteByte('?')
				}
			}
			sb.WriteByte(')')
		}
		if _, err := tx.ExecContext(ctx, sb.String(), batch...); err != nil {
			return err
		}
		n += inBatch
		batch, inBatch = batch[:0], 0
		return nil
	}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return n, err
		}
		for i, v := range vals {
			cv, err := convertValue(v, colTypes[i])
			if err != nil {
				return n, fmt.Errorf("column %s: %w", cols[i], err)
			}
			batch = append(batch, cv)
		}
		inBatch++
		if inBatch >= per {
			if err := flush(); err != nil {
				return n, err
			}
		}
	}
	if err := rows.Err(); err != nil {
		return n, err
	}
	return n, flush()
}

// convertValue turns a value read from one store into what the other's column type takes: SQLite keeps
// booleans as integers and may hand back text as bytes; Postgres wants bool, bytea and uuid.
func convertValue(v any, typ string) (any, error) {
	if v == nil {
		return nil, nil
	}
	switch typ {
	case "boolean", "bool":
		switch x := v.(type) {
		case bool:
			return x, nil
		case int64:
			return x != 0, nil
		case string:
			return x == "1" || strings.EqualFold(x, "true") || x == "t", nil
		}
	case "bytea", "blob":
		switch x := v.(type) {
		case []byte:
			return x, nil
		case string:
			return []byte(x), nil
		}
	case "uuid":
		switch x := v.(type) {
		case string:
			return x, nil
		case []byte:
			if len(x) == 16 {
				h := hex.EncodeToString(x)
				return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], nil
			}
			return string(x), nil
		}
	case "bigint", "integer", "smallint", "int", "int8", "int4", "int2":
		switch x := v.(type) {
		case int64:
			return x, nil
		case bool:
			if x {
				return int64(1), nil
			}
			return int64(0), nil
		case float64:
			return int64(x), nil
		case string:
			return strconv.ParseInt(x, 10, 64)
		case []byte:
			return strconv.ParseInt(string(x), 10, 64)
		}
	case "text", "character varying", "varchar", "jsonb", "json":
		switch x := v.(type) {
		case []byte:
			return string(x), nil
		}
	}
	return v, nil
}
