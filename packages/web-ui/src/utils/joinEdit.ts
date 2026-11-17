import type {TableColumn} from '@/types/editor';

/**
 * Editing the result of a JOIN query (issue #690).
 *
 * The grid edits a result through the `update_record` command, which needs one
 * table, that table's primary key and real column names. A JOIN result has no
 * such table, so this module works out, from the SQL text and the joined tables'
 * column lists, which result column comes from which table. The user then picks
 * one of the tables whose whole primary key is in the result, and the grid edits
 * that table's columns only.
 *
 * Everything here is deliberately conservative: whenever a column cannot be
 * traced to exactly one table with certainty (alias, expression, duplicate name,
 * subquery, self join...) it stays read-only.
 */

type TokenKind = 'word' | 'quoted' | 'string' | 'punct';

interface Token {
    kind: TokenKind;
    /** Identifier text without quotes, or the raw character for punctuation. */
    text: string;
    upper: string;
    depth: number;
}

export interface JoinTable {
    /** Real table name, as written in the query. */
    table: string;
    /** Name the query uses to qualify its columns: the alias, else the table. */
    qualifier: string;
}

export interface ParsedJoinQuery {
    tables: JoinTable[];
    /** Raw select-list items, as token groups. */
    items: Token[][];
}

export interface JoinEditCandidate {
    table: string;
    /** Primary key column names, as they appear in the result. */
    pkColumns: string[];
    /** Metadata of the table columns present in the result, named as in the result. */
    columnMetadata: TableColumn[];
}

const JOIN_STARTERS = new Set([
    'JOIN',
    'INNER',
    'LEFT',
    'RIGHT',
    'FULL',
    'CROSS',
    'OUTER',
    'NATURAL',
    'STRAIGHT_JOIN',
]);

const FROM_TERMINATORS = new Set(['WHERE', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'WINDOW']);

/** Top-level keywords after which rows no longer map one-to-one to table rows. */
const REJECTED_KEYWORDS = new Set([
    'DISTINCT',
    'GROUP',
    'HAVING',
    'UNION',
    'INTERSECT',
    'EXCEPT',
    'INTO',
    'WITH',
]);

const AGGREGATES = new Set([
    'COUNT',
    'SUM',
    'AVG',
    'MIN',
    'MAX',
    'GROUP_CONCAT',
    'STRING_AGG',
    'ARRAY_AGG',
    'JSON_AGG',
    'JSONB_AGG',
]);

function tokenize(sql: string): Token[] | null {
    const tokens: Token[] = [];
    let depth = 0;
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        if (/\s/.test(ch)) {
            i += 1;
        } else if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') i += 1;
        } else if (ch === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            if (end === -1) return null;
            i = end + 2;
        } else if (ch === "'" || ch === '"' || ch === '`') {
            let j = i + 1;
            let text = '';
            for (;;) {
                if (j >= sql.length) return null;
                if (sql[j] === ch) {
                    if (sql[j + 1] === ch) {
                        text += ch;
                        j += 2;
                        continue;
                    }
                    break;
                }
                text += sql[j];
                j += 1;
            }
            tokens.push({
                kind: ch === "'" ? 'string' : 'quoted',
                text,
                upper: text.toUpperCase(),
                depth,
            });
            i = j + 1;
        } else if (/[A-Za-z0-9_$]/.test(ch)) {
            let j = i + 1;
            while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j += 1;
            const text = sql.slice(i, j);
            tokens.push({kind: 'word', text, upper: text.toUpperCase(), depth});
            i = j;
        } else {
            if (ch === ')') depth = Math.max(0, depth - 1);
            tokens.push({kind: 'punct', text: ch, upper: ch, depth});
            if (ch === '(') depth += 1;
            i += 1;
        }
    }
    return tokens;
}

const isIdent = (t: Token | undefined): t is Token =>
    !!t && (t.kind === 'quoted' || (t.kind === 'word' && !/^\d/.test(t.text)));

const isKeyword = (t: Token | undefined, word: string): boolean =>
    !!t && t.kind === 'word' && t.upper === word;

/**
 * Parses a plain `SELECT ... FROM a JOIN b ...` statement. Returns null for
 * anything that is not a flat join of at least two distinct real tables.
 */
export function parseJoinQuery(
    sql: string,
    expectedSchema?: string | null,
): ParsedJoinQuery | null {
    const tokens = tokenize(sql);
    if (!tokens || !isKeyword(tokens[0], 'SELECT')) return null;

    // Anything that changes what one grid row stands for rules the query out.
    for (let i = 0; i < tokens.length; i += 1) {
        const t = tokens[i];
        if (t.kind !== 'word' || t.depth !== 0) continue;
        if (REJECTED_KEYWORDS.has(t.upper)) return null;
        if (AGGREGATES.has(t.upper) && tokens[i + 1]?.text === '(') return null;
    }

    const fromIndex = tokens.findIndex((t) => t.depth === 0 && isKeyword(t, 'FROM'));
    if (fromIndex === -1) return null;

    // Select list: split on top-level commas.
    const items: Token[][] = [];
    let current: Token[] = [];
    for (const t of tokens.slice(1, fromIndex)) {
        if (t.depth === 0 && t.kind === 'punct' && t.text === ',') {
            items.push(current);
            current = [];
        } else {
            current.push(t);
        }
    }
    items.push(current);
    if (items.some((item) => item.length === 0)) return null;

    // FROM clause up to the first terminator.
    let end = tokens.length;
    for (let i = fromIndex + 1; i < tokens.length; i += 1) {
        const t = tokens[i];
        if (t.depth === 0 && t.kind === 'word' && FROM_TERMINATORS.has(t.upper)) {
            end = i;
            break;
        }
        if (t.depth === 0 && t.kind === 'punct' && t.text === ';') {
            end = i;
            break;
        }
    }
    const from = tokens.slice(fromIndex + 1, end);

    const tables: JoinTable[] = [];
    let pos = 0;
    const isJoinStart = (t: Token | undefined): boolean =>
        !!t &&
        t.depth === 0 &&
        t.kind === 'word' &&
        JOIN_STARTERS.has(t.upper) &&
        from[from.indexOf(t) + 1]?.text !== '(';

    const readTable = (): boolean => {
        const first = from[pos];
        if (!isIdent(first) || first.depth !== 0) return false;
        pos += 1;
        let schema: string | null = null;
        let table = first.text;
        if (from[pos]?.text === '.' && from[pos]?.kind === 'punct') {
            const second = from[pos + 1];
            if (!isIdent(second)) return false;
            schema = table;
            table = second.text;
            pos += 2;
            if (from[pos]?.text === '.' && from[pos]?.kind === 'punct') return false;
        }
        if (schema && schema !== expectedSchema) return false;
        if (from[pos]?.text === '(') return false;

        let alias = table;
        if (isKeyword(from[pos], 'AS')) {
            const named = from[pos + 1];
            if (!isIdent(named)) return false;
            alias = named.text;
            pos += 2;
        } else if (
            isIdent(from[pos]) &&
            from[pos].depth === 0 &&
            !isKeyword(from[pos], 'ON') &&
            !isKeyword(from[pos], 'USING') &&
            !(from[pos].kind === 'word' && JOIN_STARTERS.has(from[pos].upper))
        ) {
            alias = from[pos].text;
            pos += 1;
        }
        tables.push({table, qualifier: alias});
        return true;
    };

    if (!readTable()) return null;
    while (pos < from.length) {
        // One join: modifiers, JOIN, table, then ON (...) or USING (...).
        if (!isJoinStart(from[pos])) return null;
        let sawJoin = false;
        while (pos < from.length && isJoinStart(from[pos])) {
            if (isKeyword(from[pos], 'NATURAL')) return null;
            if (isKeyword(from[pos], 'JOIN') || isKeyword(from[pos], 'STRAIGHT_JOIN')) {
                sawJoin = true;
                pos += 1;
                break;
            }
            pos += 1;
        }
        if (!sawJoin || !readTable()) return null;
        if (pos < from.length && !isJoinStart(from[pos])) {
            if (!isKeyword(from[pos], 'ON') && !isKeyword(from[pos], 'USING')) return null;
            pos += 1;
            while (pos < from.length && !isJoinStart(from[pos])) {
                // A comma between top-level join clauses is an implicit join.
                if (from[pos].depth === 0 && from[pos].text === ',') return null;
                pos += 1;
            }
        }
    }

    if (tables.length < 2) return null;
    // A self join (the same table twice) cannot tell which side a column is from.
    const lowerTables = tables.map((t) => t.table.toLowerCase());
    if (new Set(lowerTables).size !== lowerTables.length) return null;
    const lowerQualifiers = tables.map((t) => t.qualifier.toLowerCase());
    if (new Set(lowerQualifiers).size !== lowerQualifiers.length) return null;

    return {tables, items};
}

/**
 * For each result column, the joined table it comes from, or null when it cannot
 * be traced to one table with certainty (aliased, computed, duplicated name, or
 * the select list does not line up with the result).
 */
export function resolveColumnSources(
    parsed: ParsedJoinQuery,
    resultColumns: string[],
    columnsByTable: Record<string, string[]>,
): (string | null)[] {
    const none = resultColumns.map(() => null);
    const lower = (s: string) => s.toLowerCase();
    const byQualifier = new Map(parsed.tables.map((t) => [lower(t.qualifier), t.table]));
    const columnsOf = (table: string): string[] => columnsByTable[table] ?? [];

    // `expected` is the result name when it is known, otherwise null.
    const resolved: {table: string | null; expected: string | null}[] = [];

    for (const item of parsed.items) {
        const parts = item.map((t) => t.text);
        const isStar = (t: Token | undefined) => t?.kind === 'punct' && t.text === '*';

        if (item.length === 1 && isStar(item[0])) {
            for (const t of parsed.tables) {
                for (const c of columnsOf(t.table)) resolved.push({table: t.table, expected: c});
            }
            continue;
        }
        if (item.length === 3 && isIdent(item[0]) && item[1].text === '.' && isStar(item[2])) {
            const table = byQualifier.get(lower(parts[0]));
            if (!table) return none;
            for (const c of columnsOf(table)) resolved.push({table, expected: c});
            continue;
        }

        // `[qualifier.]column [[AS] alias]`
        let column: string | null = null;
        let table: string | null = null;
        let rest = item;
        if (item.length >= 3 && isIdent(item[0]) && item[1].text === '.' && isIdent(item[2])) {
            table = byQualifier.get(lower(parts[0])) ?? null;
            column = parts[2];
            rest = item.slice(3);
        } else if (isIdent(item[0]) && !(item[1]?.text === '(' || item[1]?.text === '.')) {
            column = parts[0];
            rest = item.slice(1);
            const owners = parsed.tables.filter((t) =>
                columnsOf(t.table).some((c) => lower(c) === lower(column as string)),
            );
            table = owners.length === 1 ? owners[0].table : null;
        }

        let alias: string | null = null;
        if (column !== null && rest.length > 0) {
            if (rest.length === 2 && isKeyword(rest[0], 'AS') && isIdent(rest[1])) {
                alias = rest[1].text;
            } else if (rest.length === 1 && isIdent(rest[0])) {
                alias = rest[0].text;
            } else {
                column = null;
                table = null;
            }
        }

        if (column === null) {
            // An expression or something unparsed: it takes one result column,
            // whose name we cannot know.
            resolved.push({table: null, expected: null});
        } else if (alias !== null && lower(alias) !== lower(column)) {
            resolved.push({table: null, expected: alias});
        } else {
            resolved.push({table, expected: column});
        }
    }

    if (resolved.length !== resultColumns.length) return none;
    for (let i = 0; i < resolved.length; i += 1) {
        const expected = resolved[i].expected;
        if (expected !== null && lower(expected) !== lower(resultColumns[i])) return none;
    }

    // A name shown twice cannot be told apart in the grid, so neither is editable.
    const counts = new Map<string, number>();
    for (const c of resultColumns) counts.set(lower(c), (counts.get(lower(c)) ?? 0) + 1);

    return resolved.map((r, i) =>
        (counts.get(lower(resultColumns[i])) ?? 0) > 1 ? null : r.table,
    );
}

/**
 * The tables of a join result that can be edited: each one's whole primary key
 * must be in the result, taken from that table.
 */
export function buildJoinEditCandidates(
    parsed: ParsedJoinQuery,
    resultColumns: string[],
    sources: (string | null)[],
    metadataByTable: Record<string, TableColumn[]>,
): JoinEditCandidate[] {
    const candidates: JoinEditCandidate[] = [];
    for (const {table} of parsed.tables) {
        const metadata = metadataByTable[table] ?? [];
        const pk = metadata.filter((c) => c.is_pk);
        if (pk.length === 0) continue;

        // Result column (as named in the result) for each of the table's columns.
        const resultNameOf = new Map<string, string>();
        resultColumns.forEach((name, i) => {
            if (sources[i] === table) resultNameOf.set(name.toLowerCase(), name);
        });

        const pkColumns = pk.map((c) => resultNameOf.get(c.name.toLowerCase()));
        if (pkColumns.some((c) => c === undefined)) continue;

        const columnMetadata = metadata.flatMap((c) => {
            const name = resultNameOf.get(c.name.toLowerCase());
            return name === undefined ? [] : [{...c, name}];
        });
        candidates.push({table, pkColumns: pkColumns as string[], columnMetadata});
    }
    return candidates;
}

/**
 * Rows from the non-target side of an outer join have no key value. Updating
 * them would address no row (or the wrong one), so they are refused.
 */
export function findKeylessJoinUpdates<T extends {pkVal: Record<string, unknown>}>(
    updates: T[],
): T[] {
    return updates.filter((u) => Object.values(u.pkVal).some((v) => v === null || v === undefined));
}

/** Tab fields that make the grid edit `candidate` in a join result. */
export function joinTargetPatch(candidate: JoinEditCandidate) {
    const {columnMetadata} = candidate;
    return {
        activeTable: candidate.table,
        pkColumns: candidate.pkColumns,
        columnMetadata,
        autoIncrementColumns: columnMetadata.filter((c) => c.is_auto_increment).map((c) => c.name),
        defaultValueColumns: columnMetadata
            .filter((c) => c.default_value !== undefined && c.default_value !== null)
            .map((c) => c.name),
        nullableColumns: columnMetadata.filter((c) => c.is_nullable).map((c) => c.name),
        // Foreign-key navigation is keyed by the single-table column names.
        foreignKeys: [],
    };
}
