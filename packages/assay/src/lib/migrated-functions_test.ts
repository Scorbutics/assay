/**
 * The migration replay behind `assay rpc-map --check`, pinned on the case that
 * motivated it: a migration added `list_my_referees()` and the committed map was
 * not regenerated, which only a nightly run against a live database noticed.
 */

import { expect, test } from 'bun:test'
import { compareToMap, functionsFromMigrations } from './migrated-functions.ts'

const alive = (...sql: string[]) =>
    [...functionsFromMigrations(sql.map((s, i) => ({ file: `${String(i).padStart(4, '0')}_m.sql`, sql: s })))].sort()

test('a function added by a later migration is missing from a map that predates it', () => {
    const fns = functionsFromMigrations([
        { file: '0001_init.sql', sql: 'CREATE FUNCTION public.count_active_referees() RETURNS int LANGUAGE sql AS $$ select 1 $$;' },
        { file: '0187_list_my_referees.sql', sql: 'CREATE OR REPLACE FUNCTION public.list_my_referees()\nRETURNS TABLE (id uuid) LANGUAGE sql AS $$ select 1 $$;' },
    ])
    expect(compareToMap(fns, ['count_active_referees'])).toEqual({ missing: ['list_my_referees'], extra: [] })
    expect(compareToMap(fns, ['count_active_referees', 'list_my_referees'])).toEqual({ missing: [], extra: [] })
})

test('files apply in lexical order, not the order they were handed over', () => {
    const fns = functionsFromMigrations([
        { file: '0002_drop.sql', sql: 'DROP FUNCTION f();' },
        { file: '0001_create.sql', sql: 'CREATE FUNCTION f() RETURNS void AS $$ $$ LANGUAGE sql;' },
    ])
    expect([...fns]).toEqual([])
})

test('a drop list removes every name in it, with signatures, IF EXISTS and CASCADE', () => {
    expect(alive(
        'create function a(x int) returns int as $$ select 1 $$ language sql; create function b() returns int as $$ select 1 $$ language sql; create function c() returns int as $$ select 1 $$ language sql;',
        'drop function if exists public.a(int), b cascade;',
    )).toEqual(['c'])
})

test('statements inside one file apply in order: drop-then-recreate survives', () => {
    expect(alive('create function f() returns int as $$ select 1 $$ language sql;\ndrop function f();\ncreate function f(x int) returns int as $$ select x $$ language sql;')).toEqual(['f'])
})

test('rename moves the key; set schema out of public removes it', () => {
    expect(alive(
        'create function old_name() returns int as $$ select 1 $$ language sql; create function moved() returns int as $$ select 1 $$ language sql;',
        'alter function public.old_name() rename to new_name; alter function moved() set schema private;',
    )).toEqual(['new_name'])
})

test('only public: another schema is not in the map', () => {
    expect(alive('create function private.helper() returns int as $$ select 1 $$ language sql; create function "public"."shown"() returns int as $$ select 1 $$ language sql;'))
        .toEqual(['shown'])
})

test('identifiers fold like Postgres: bare to lower case, quoted kept', () => {
    expect(alive('CREATE FUNCTION Public.Upper_Fn() RETURNS int AS $$ select 1 $$ LANGUAGE sql; CREATE FUNCTION "MixedCase"() RETURNS int AS $$ select 1 $$ LANGUAGE sql;'))
        .toEqual(['MixedCase', 'upper_fn'])
})

test('procedures are not functions (rpc-map reads prokind = f)', () => {
    expect(alive('create procedure p() language sql as $$ select 1 $$;')).toEqual([])
})

test('commented-out DDL does not count', () => {
    expect(alive('-- create function ghost() returns int\n/* drop function kept();\n create function ghost2() */ create function kept() returns int as $$ select 1 $$ language sql;'))
        .toEqual(['kept'])
})

test('a key the migrations never leave behind is reported as extra', () => {
    expect(compareToMap(new Set(['a']), ['a', 'ghost'])).toEqual({ missing: [], extra: ['ghost'] })
})
