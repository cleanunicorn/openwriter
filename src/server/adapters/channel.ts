/** A push-based AsyncIterable: adapters push progress, the manager iterates. */
export function createChannel<T>(): {
  push: (value: T) => void
  close: () => void
  iterable: AsyncIterable<T>
} {
  const buffer: T[] = []
  let closed = false
  let wake: (() => void) | undefined
  return {
    push: (value) => {
      if (closed) return
      buffer.push(value)
      wake?.()
    },
    close: () => {
      closed = true
      wake?.()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (buffer.length > 0) yield buffer.shift() as T
          if (closed) return
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          wake = undefined
        }
      },
    },
  }
}
