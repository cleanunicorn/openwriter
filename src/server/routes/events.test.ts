import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventHub } from '../sse.ts'
import { createTestApp, json, type TestApp } from '../test-helpers.ts'

let t: TestApp
beforeEach(() => {
  t = createTestApp()
})
afterEach(() => t.cleanup())

/** Open an event stream and wait for its `hello`: from then on the server counts it. */
async function connect(query: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await t.get(`/api/events${query}`)
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('no stream')
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain('event: hello')
  return reader
}

describe('the tabs with an open event stream', () => {
  it('are listed beside the jobs, once each, and only while their stream is open', async () => {
    const one = await connect('?tab=tab-aaaaaaaa')
    const again = await connect('?tab=tab-aaaaaaaa')
    const other = await connect('?tab=tab-bbbbbbbb')
    expect((await json(t.get('/api/jobs'))).tabs.sort()).toEqual(['tab-aaaaaaaa', 'tab-bbbbbbbb'])

    // The streams end (a reload, a closed tab): nobody is left to apply those tabs' jobs.
    expect(t.context.events.dropStreams()).toBe(3)
    expect((await json(t.get('/api/jobs'))).tabs).toEqual([])
    await Promise.all([one, again, other].map((reader) => reader.cancel()))
  })

  it('forgets a tab whose client went away', async () => {
    const reader = await connect('?tab=tab-dddddddd')
    expect((await json(t.get('/api/jobs'))).tabs).toEqual(['tab-dddddddd'])
    await reader.cancel()
    await expect.poll(async () => (await json(t.get('/api/jobs'))).tabs).toEqual([])
  })

  it('does not count a stream that names no tab, or something that is not a tab ID', async () => {
    const none = await connect('')
    const bogus = await connect('?tab=../../etc')
    expect((await json(t.get('/api/jobs'))).tabs).toEqual([])
    t.context.events.dropStreams()
    await Promise.all([none, bogus].map((reader) => reader.cancel()))
  })
})

describe('EventHub.connectedTabs', () => {
  it('forgets a tab when its last stream is untracked', () => {
    const hub = new EventHub()
    const first = hub.trackStream(() => {}, 'tab-cccccccc')
    const second = hub.trackStream(() => {}, 'tab-cccccccc')
    hub.trackStream(() => {})
    first()
    expect(hub.connectedTabs()).toEqual(['tab-cccccccc'])
    second()
    expect(hub.connectedTabs()).toEqual([])
  })
})
