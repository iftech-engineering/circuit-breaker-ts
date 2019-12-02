export type Bucket = {
  failures: number
  successes: number
  timeouts: number
  ignores: number,
  shortCircuits: number
}

export type Metrics = {
  totalCount: number
  errorCount: number
  errorPercentage: number
}

export type Command<T> = () => Promise<T> | T

export type Fallback = () => void

export enum CircuitBreakerStatus {
  OPEN = 0,
  HALF_OPEN = 1,
  CLOSED = 2,
}

export class CircuitOpenError extends Error {
  name = 'CIRCUIT_OPEN'
  constructor(msg: string = 'Circuit Open') {
    super(msg)
  }
}
class CircuitWorkerTimeout extends Error {
  name = 'CIRCUIT_WORKER_TIMEOUT'
  constructor(msg: string = 'Circuit worker timeout') {
    super(msg)
  }
}

function wrapPromise<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    const ret = fn()
    return Promise.resolve(ret)
  } catch (e) {
    return Promise.reject(e)
  }
}

export default class CircuitBreaker {
  static readonly OPEN = CircuitBreakerStatus.OPEN
  static readonly HALF_OPEN = CircuitBreakerStatus.HALF_OPEN
  static readonly CLOSED = CircuitBreakerStatus.CLOSED

  windowDuration: number
  numBuckets: number
  timeoutDuration: number
  errorThreshold: number
  volumeThreshold: number
  onCircuitOpen: (metrics: Metrics) => void
  onCircuitClose: (metrics: Metrics) => void
  circuitFilter: (err: any) => boolean

  _buckets: Bucket[]
  _state: CircuitBreakerStatus | null
  _forced: CircuitBreakerStatus | null
  _interval: number

  constructor(opts: {
    windowDuration?: number
    numBuckets?: number
    timeoutDuration?: number
    errorThreshold?: number
    volumeThreshold?: number
    onCircuitOpen?: (metrics: Metrics) => void
    onCircuitClose?: (metrics: Metrics) => void
    circuitFilter?: (err: any) => boolean
  } = {}) {
    this.windowDuration = opts.windowDuration || 10000  // milliseconds
    this.numBuckets = opts.numBuckets || 10             // number
    this.timeoutDuration = opts.timeoutDuration || 3000 // milliseconds
    this.errorThreshold = opts.errorThreshold || 50     // percentage
    this.volumeThreshold = opts.volumeThreshold || 5    // number

    this.onCircuitOpen = opts.onCircuitOpen || function () { }
    this.onCircuitClose = opts.onCircuitClose || function () { }
    this.circuitFilter = opts.circuitFilter || function () {
      return true
    }

    this._buckets = [this._createBucket()]
    this._state = CircuitBreaker.CLOSED

    this._startTicker()
  }

  async run<T>(command: Command<T>): Promise<T> {
    if (this.isOpen()) {
      this._incrementShortCircuits()
      throw new CircuitOpenError()
    }
    else {
      return this._executeCommand(command)
    }
  }

  forceClose(): void {
    this._forced = this._state
    this._state = CircuitBreaker.CLOSED
  }

  forceOpen(): void {
    this._forced = this._state
    this._state = CircuitBreaker.OPEN
  }

  unforce(): void {
    this._state = this._forced
    this._forced = null
  }

  isOpen(): boolean {
    return this._state == CircuitBreaker.OPEN
  }

  destroy(): void {
    clearInterval(this._interval)
  }

  _startTicker(): void {
    const self = this
    let bucketIndex = 0
    const bucketDuration = this.windowDuration / this.numBuckets

    function tick() {
      if (self._buckets.length > self.numBuckets) {
        self._buckets.shift()
      }

      bucketIndex++

      if (bucketIndex > self.numBuckets) {
        bucketIndex = 0

        if (self.isOpen()) {
          self._state = CircuitBreaker.HALF_OPEN
        }
      }

      self._buckets.push(self._createBucket())
    }

    this._interval = setInterval(tick, bucketDuration)
  }

  _createBucket(): Bucket {
    return { failures: 0, successes: 0, timeouts: 0, shortCircuits: 0, ignores: 0 }
  }

  _lastBucket(): Bucket {
    return this._buckets[this._buckets.length - 1]
  }

  
  _executeCommand<T>(command: Command<T>): Promise<T> {
    const self = this
    let timeout: number | null

    function increment<P extends 'successes' | 'failures' | 'timeouts' | 'ignores'>(prop: P) {
      return function() {
        const bucket = self._lastBucket()
        bucket[prop]++

        if (self._forced == null) {
          self._updateState()
        }

        clearTimeout(timeout!)
        timeout = null
      }
    }

    return new Promise((resolve, reject) => {
      wrapPromise(command).then(
        (result: T) => {
          if (!timeout) return
          increment('successes')()
          resolve(result)
        },
        (reason: any) => {
          if (!timeout) return
          if (!this.circuitFilter(reason)) {
            increment('ignores')()
          } else {
            increment('failures')()
          }
          reject(reason)
        },
      )

      timeout = setTimeout(() => {
        if (!timeout) return
        increment('timeouts')()
        reject(new CircuitWorkerTimeout())
      }, this.timeoutDuration)
    })
  }

  _incrementShortCircuits(): void {
    const bucket = this._lastBucket()
    bucket.shortCircuits++
  }

  _calculateMetrics(): Metrics {
    let totalCount = 0, errorCount = 0, errorPercentage = 0

    for (let i = 0, l = this._buckets.length; i < l; i++) {
      const bucket = this._buckets[i]
      const errors = (bucket.failures + bucket.timeouts)

      errorCount += errors
      totalCount += (errors + bucket.successes)
    }

    errorPercentage = (errorCount / (totalCount > 0 ? totalCount : 1)) * 100

    return { totalCount: totalCount, errorCount: errorCount, errorPercentage: errorPercentage }
  }

  _updateState(): void {
    const metrics = this._calculateMetrics()

    if (this._state == CircuitBreaker.HALF_OPEN) {
      const lastCommandFailed = !this._lastBucket().successes && metrics.errorCount > 0

      if (lastCommandFailed) {
        this._state = CircuitBreaker.OPEN
        this.onCircuitOpen(metrics)
      }
      else {
        this._state = CircuitBreaker.CLOSED
        this.onCircuitClose(metrics)
      }
    }
    else {
      const overErrorThreshold = metrics.errorPercentage > this.errorThreshold
      const overVolumeThreshold = metrics.totalCount > this.volumeThreshold
      const overThreshold = overVolumeThreshold && overErrorThreshold

      if (overThreshold) {
        this._state = CircuitBreaker.OPEN
        this.onCircuitOpen(metrics)
      }
    }
  }
}
