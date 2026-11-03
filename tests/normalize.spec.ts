import { describe, expect, it } from 'vitest'
import {
  isAbsoluteConfigPath, isSafeRelativePath, localBranchName, nameIssue, parseIncludeFile, sanitizeDirName, segmentGlob,
  shortCodeName,
} from '../src/normalize.js'

describe('nameIssue', () => {
  it('accepts plain, dotted and slashed names', () => {
    for (const name of ['feat-login', 'fix_1.2', 'feat/login', 'a', '登录修复', 'feat/登录超时', '修复_1.2']) {
      expect(nameIssue(name), name).toBeNull()
    }
  })
  it('flags empty names', () => {
    expect(nameIssue('')).toBe('empty')
    expect(nameIssue('   ')).toBe('empty')
  })
  it('flags names that are too long', () => {
    expect(nameIssue('a'.repeat(81))).toBe('tooLong')
  })
  it('flags illegal names', () => {
    for (const name of ['-x', 'a b', '登录 修复', '登录😀', 'a..b', 'a//b', 'a/', 'a.', '.hidden', 'a/.b', 'x.lock', 'a~b', 'a:b', '/a', 'a@{b}']) {
      expect(nameIssue(name), name).toBe('illegal')
    }
  })
})

describe('sanitizeDirName', () => {
  it('flattens separators', () => {
    expect(sanitizeDirName('feat/login')).toBe('feat-login')
  })
  it('keeps Chinese so the directory stays recognizable', () => {
    expect(sanitizeDirName('登录修复')).toBe('登录修复')
    expect(sanitizeDirName('功能/超时')).toBe('功能-超时')
  })
  it('keeps a single interior dot', () => {
    expect(sanitizeDirName('v1.2.3')).toBe('v1.2.3')
  })
  it('never returns an empty or dash-only name', () => {
    expect(sanitizeDirName('///')).toBe('worktree')
    expect(sanitizeDirName('')).toBe('worktree')
  })
  it('clamps long names', () => {
    expect(sanitizeDirName('a'.repeat(200)).length).toBe(64)
  })
})

describe('shortCodeName / localBranchName', () => {
  it('builds wt-xxxxxx deterministically', () => {
    expect(shortCodeName([0, 1, 2, 3, 4, 5])).toMatch(/^wt-[a-z0-9]{6}$/)
    expect(shortCodeName([0, 1, 2, 3, 4, 5])).toBe(shortCodeName([0, 1, 2, 3, 4, 5]))
  })
  it('strips a remote prefix', () => {
    expect(localBranchName('origin/main')).toBe('main')
    expect(localBranchName('main')).toBe('main')
    expect(localBranchName('origin/feat/x')).toBe('feat/x')
  })
})

describe('paths', () => {
  it('recognizes absolute config paths', () => {
    expect(isAbsoluteConfigPath('/a/b')).toBe(true)
    expect(isAbsoluteConfigPath('C:\\a')).toBe(true)
    expect(isAbsoluteConfigPath('\\\\host\\share')).toBe(true)
    expect(isAbsoluteConfigPath('rel/a')).toBe(false)
    expect(isAbsoluteConfigPath('')).toBe(false)
  })
  it('judges copy entries', () => {
    for (const ok of ['.env', 'config/local.json', 'a/*.json']) expect(isSafeRelativePath(ok)).toBe(true)
    for (const bad of ['', '/etc/passwd', 'C:\\x', '../x', 'a/../../x', '.git/config', '.git', 'a\u0000b']) {
      expect(isSafeRelativePath(bad), bad).toBe(false)
    }
  })
  it('parses the include file', () => {
    expect(parseIncludeFile('# c\n\n .env \r\nconfig/x\n')).toEqual(['.env', 'config/x'])
  })
  it('compiles single-level globs', () => {
    expect(segmentGlob('.env.*').test('.env.local')).toBe(true)
    expect(segmentGlob('.env.*').test('.envx')).toBe(false)
    expect(segmentGlob('a?c').test('abc')).toBe(true)
    expect(segmentGlob('a.b').test('axb')).toBe(false)
  })
})
