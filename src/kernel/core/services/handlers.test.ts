import { describe, expect, it } from 'vitest'
import { fakeFs } from '../fakeFs.testkit'
import { createKernelServices } from '../services'
import { SERVICE_TABLE, type ServiceDescriptor } from '../serviceTable'
import { buildServices } from './handlers'

/**
 * `only` NARROWS THE TABLE AND CANNOT ADD TO IT.
 *
 * A contribution carries the grant the router checks, so a descriptor that is
 * not the table's own is a permission the table never recorded: clone
 * `trash.empty`, weaken its grant to `book:read`, and the whole trash is
 * reachable with a reading grant.
 */
describe('buildServices and the list it is given', () => {
  const env = () => ({ services: createKernelServices({ fs: fakeFs(), storage: null, initialBooks: [] }) })

  it('refuses a descriptor the table does not hold', () => {
    const real = SERVICE_TABLE.find((one) => one.name === 'trash.empty')
    const forged = { ...(real as ServiceDescriptor), grant: 'book:read' } as ServiceDescriptor
    expect(() => buildServices(env(), [forged])).toThrow(/is not a descriptor from the service table/)
  })

  it('refuses the same descriptor twice', () => {
    const real = SERVICE_TABLE[0] as ServiceDescriptor
    expect(() => buildServices(env(), [real, real])).toThrow(/is listed twice/)
  })

  /* ⚠️ **READ ONCE.** The check walked `only` with `for…of` and the build
     then walked it again through its OWN `.map()` — two reads of a caller's
     object, which is free to answer differently each time. This one shows the
     table's descriptor to the check and a forgery to the build, which is
     exactly the bypass the check exists to close. */
  it('reads the list once, so a two-faced one cannot smuggle a weaker grant past the check', () => {
    const real = SERVICE_TABLE.find((one) => one.name === 'trash.empty') as ServiceDescriptor
    const forged = { ...real, grant: 'book:read' } as ServiceDescriptor
    const twoFaced = {
      length: 1,
      *[Symbol.iterator]() {
        yield real
      },
      map: <T,>(fn: (one: ServiceDescriptor) => T) => [forged].map(fn),
    } as unknown as readonly ServiceDescriptor[]

    const built = buildServices(env(), twoFaced)
    expect(built).toHaveLength(1)
    expect(built[0]?.grant).toBe(real.grant)
    expect(built[0]?.grant).not.toBe('book:read')
  })
})
