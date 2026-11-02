import { describe, expect, it } from 'vitest'
import { CardForm, parseLines, type SectionValue } from '../src/client/card-form.ts'

/** In-memory ConfigForm double mirroring the host contract's observable parts. */
function fakeScope(initial: SectionValue = {}, options: { accept?: boolean; writable?: boolean; status?: 'ready' | 'loading' } = {}) {
  let snapshot = {
    status: options.status ?? 'ready' as const,
    value: initial as SectionValue | undefined,
    base: undefined,
    user: { ...initial } as unknown,
    revision: 1,
    writable: options.writable ?? true,
    mode: 'host' as const,
  }
  const listeners = new Set<() => void>()
  const writes: Array<{ op: 'set' | 'unset'; field: string; value?: unknown }> = []
  const notify = (): void => { for (const listener of listeners) listener() }
  return {
    writes,
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      mutate: async () => true,
      set: async (field: string, value: unknown) => {
        writes.push({ op: 'set', field, value })
        if (options.accept === false) return false
        snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value }, user: { ...(snapshot.user as object), [field]: value } }
        notify()
        return true
      },
      unset: async (field: string) => {
        writes.push({ op: 'unset', field })
        if (options.accept === false) return false
        const value = { ...snapshot.value } as Record<string, unknown>
        delete value[field]
        const user = { ...(snapshot.user as object) } as Record<string, unknown>
        delete user[field]
        snapshot = { ...snapshot, value: value as SectionValue, user }
        notify()
        return true
      },
    },
  }
}

describe('parseLines', () => {
  it('trims and drops blank lines', () => {
    expect(parseLines(' .env \r\n\n  config/x  \n')).toEqual(['.env', 'config/x'])
    expect(parseLines('')).toEqual([])
  })
})

describe('CardForm projection', () => {
  it('projects defaults and stored values', () => {
    const { scope } = fakeScope({ namingMode: 'auto', autoCleanup: false, copyFiles: ['.env', 'a/b'] })
    const state = new CardForm(scope as never).bind().getSnapshot()
    expect(state).toMatchObject({
      available: true, writable: true, namingMode: 'auto', autoCleanup: false,
      deleteBranchOnCleanup: true, fetchBaseBeforeCreate: true, copyFilesText: '.env\na/b', dirty: false,
    })
    const empty = new CardForm(fakeScope({}).scope as never).bind().getSnapshot()
    expect(empty).toMatchObject({ namingMode: 'manual', autoCleanup: true, deleteBranchOnCleanup: true, fetchBaseBeforeCreate: true, copyFilesText: '' })
  })

  it('is unavailable until the namespace is ready', () => {
    const state = new CardForm(fakeScope({}, { status: 'loading' }).scope as never).bind().getSnapshot()
    expect(state.available).toBe(false)
  })

  it('keeps the same snapshot reference while nothing moved', () => {
    const { scope } = fakeScope({})
    const store = new CardForm(scope as never).bind()
    const first = store.getSnapshot()
    store.set({ ...first })
    expect(store.getSnapshot()).toBe(first)
  })
})

describe('CardForm staged edits', () => {
  it('stages, validates and saves the copy list', async () => {
    const { scope, writes } = fakeScope({})
    const form = new CardForm(scope as never)
    const store = form.bind()
    const actions = form.actions()

    actions.editCopyFiles('.env\n../escape')
    expect(store.getSnapshot()).toMatchObject({ copyFilesValid: false, dirty: true })
    await actions.save()
    expect(writes).toEqual([])

    actions.editCopyFiles('.env\n .env.local ')
    await actions.save()
    expect(writes).toEqual([
      { op: 'set', field: 'copyFiles', value: ['.env', '.env.local'] },
    ])
    expect(store.getSnapshot()).toMatchObject({ dirty: false, saving: false, failed: false, copyFilesText: '.env\n.env.local' })
  })

  it('keeps the drafts and flags a refused save', async () => {
    const { scope } = fakeScope({}, { accept: false })
    const form = new CardForm(scope as never)
    form.actions().editCopyFiles('.env')
    await form.actions().save()
    expect(form.bind().getSnapshot()).toMatchObject({ failed: true, dirty: true, copyFilesText: '.env' })
    form.actions().editCopyFiles('.env\n.env.local')
    expect(form.bind().getSnapshot().failed).toBe(false)
  })

  it('discards drafts', () => {
    const { scope } = fakeScope({ copyFiles: ['.env'] })
    const form = new CardForm(scope as never)
    form.actions().editCopyFiles('.env.local')
    expect(form.bind().getSnapshot().dirty).toBe(true)
    form.actions().discard()
    expect(form.bind().getSnapshot()).toMatchObject({ dirty: false, copyFilesText: '.env' })
  })

  it('does not count an unchanged draft as dirty', () => {
    const { scope } = fakeScope({ copyFiles: ['.env'] })
    const form = new CardForm(scope as never)
    form.actions().editCopyFiles('  .env\n\n')
    expect(form.bind().getSnapshot().dirty).toBe(false)
  })
})

describe('CardForm write-through switches', () => {
  it('writes immediately and reflects the new value', async () => {
    const { scope, writes } = fakeScope({})
    const form = new CardForm(scope as never)
    await form.actions().setNamingMode('auto')
    await form.actions().setAutoCleanup(false)
    await form.actions().setDeleteBranchOnCleanup(false)
    await form.actions().setFetchBaseBeforeCreate(false)
    expect(writes.map(write => [write.field, write.value])).toEqual([
      ['namingMode', 'auto'], ['autoCleanup', false], ['deleteBranchOnCleanup', false], ['fetchBaseBeforeCreate', false],
    ])
    expect(form.bind().getSnapshot()).toMatchObject({
      namingMode: 'auto', autoCleanup: false, deleteBranchOnCleanup: false, fetchBaseBeforeCreate: false, switchFailed: null,
    })
  })

  it('skips a write that changes nothing', async () => {
    const { scope, writes } = fakeScope({ autoCleanup: true })
    await new CardForm(scope as never).actions().setAutoCleanup(true)
    expect(writes).toEqual([])
  })

  it('records which switch was refused and clears it on a later success', async () => {
    const refused = fakeScope({}, { accept: false })
    const form = new CardForm(refused.scope as never)
    await form.actions().setAutoCleanup(false)
    expect(form.bind().getSnapshot().switchFailed).toBe('autoCleanup')

    const throwing = fakeScope({})
    throwing.scope.set = async () => { throw new Error('transport') }
    const other = new CardForm(throwing.scope as never)
    await other.actions().setNamingMode('auto')
    expect(other.bind().getSnapshot().switchFailed).toBe('namingMode')
  })
})
