import { describe, expect, it } from 'vitest'
import { NO_VOICE } from './voice'

/**
 * The port's null object. (This called it the unbound default — what a browser
 * client, a phone and a build without `inference` get. The default is the
 * machine's own voice now, `systemVoice()`; this is what a surface test hands a
 * face that has no voice.)
 *
 * Small, because the port is: everything interesting about speaking lives in the
 * machine's own voice (`reader/systemVoice.ts`) and in the one surface that
 * draws it (`reader/LookUpFace.tsx`). What has to hold HERE is that the null
 * object is safe to hold, safe to call, and honest about being nothing.
 */
describe('NO_VOICE', () => {
  /*
   * ⚠️ **FOR EVERY LANGUAGE, INCLUDING NONE**, and the case reads that way
   * because the question changed shape: it was `available`, a boolean about the
   * port, and it is now `canSay(lang)` — a machine with only English voices
   * saying a Chinese term in one is a wrong answer the reader cannot check, so
   * the language is part of the question. There is nothing behind this port at
   * all, so the answer is a KNOWN no rather than the unknown an unloaded voice
   * list gives.
   */
  it('reports itself unable to say anything, in any language, rather than pretending', () => {
    expect(NO_VOICE.canSay(null)).toBe(false)
    expect(NO_VOICE.canSay('en')).toBe(false)
    expect(NO_VOICE.canSay('zh-Hant')).toBe(false)
    expect(NO_VOICE.state()).toBe('idle')
  })

  /*
   * ⚠️ **IT IS SILENT WHERE `NO_GLOSS` IS LOUD, AND THE DIFFERENCE IS WHO CALLS
   * IT.** `NO_GLOSS.gloss` throws because every path to it has already read
   * `available`, so reaching the default is a bug worth failing on. `say` is a
   * button's own handler, and the button is simply not drawn when `available` is
   * false — a throw here would be a crash inside a control nobody can see, in
   * exactly the builds that have no voice.
   */
  it('says nothing and stops nothing, without throwing', () => {
    expect(() => NO_VOICE.say('gam')).not.toThrow()
    expect(() => NO_VOICE.say('gam', 'en-GB')).not.toThrow()
    expect(() => NO_VOICE.stop()).not.toThrow()
    expect(NO_VOICE.state()).toBe('idle')
  })

  /*
   * A STORE THAT HANDS BACK A WORKING UNSUBSCRIBE. `useSyncExternalStore` calls
   * what `subscribe` returns on unmount, so a default returning `undefined`
   * throws there — on every unmount, in every build that never bound a voice.
   * `NO_WORK_LINE` records the identical defect, which is why this case exists
   * before anybody has met it here.
   */
  it('notifies nobody, and still hands back a working unsubscribe', () => {
    const stop = NO_VOICE.subscribe(() => {
      throw new Error('the default voice notified a listener')
    })
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })
})
