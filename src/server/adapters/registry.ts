import type { AgentAdapter } from './types.ts'

/** Name → adapter. A new adapter implements `AgentAdapter` and is registered here. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>()

  register(adapter: AgentAdapter): this {
    this.adapters.set(adapter.name, adapter)
    return this
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name)
  }

  names(): string[] {
    return [...this.adapters.keys()]
  }
}
