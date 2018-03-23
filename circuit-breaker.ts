export type Bucket = {
  failures: number
  successes: number
  timeouts: number
  shortCircuits: number
}

export type Metrics = {
  totalCount: number
  errorCount: number
  errorPercentage: number
}

export type Command = (success: () => void, failed: () => void) => void

export type Fallback = () => void

export default class CircuitBreaker {
  static readonly OPEN = 0
  static readonly HALF_OPEN = 1
  static readonly CLOSED = 2

  windowDuration: number
  numBuckets: number
  timeoutDuration: number
  errorThreshold: number
  volumeThreshold: number
  onCircuitOpen: (metrics: Metrics) => void
  onCircuitClose: (metrics: Metrics) => void

  _buckets: Bucket[]
  _state: 0 | 1 | 2 | null
  _forced: 0 | 1 | 2 | null

  constructor(opts: {
    windowDuration?: number
    numBuckets?: number
    timeoutDuration?: number
    errorThreshold?: number
    volumeThreshold?: number
    onCircuitOpen?: (metrics: Metrics) => void
    onCircuitClose?: (metrics: Metrics) => void
  } = {}) {
    this.windowDuration = opts.windowDuration || 10000  // milliseconds
    this.numBuckets = opts.numBuckets || 10             // number
    this.timeoutDuration = opts.timeoutDuration || 3000 // milliseconds
    this.errorThreshold = opts.errorThreshold || 50     // percentage
    this.volumeThreshold = opts.volumeThreshold || 5    // number

    this.onCircuitOpen = opts.onCircuitOpen || function () { }
    this.onCircuitClose = opts.onCircuitClose || function () { }

    this._buckets = [this._createBucket()]
    this._state = CircuitBreaker.CLOSED

    this._startTicker()
  }

  run(command: Command, fallback?: Fallback): void {
    if (this.isOpen()) {
      this._executeFallback(fallback || function () { })
    }
    else {
      this._executeCommand(command)
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

    setInterval(tick, bucketDuration)
  }

  _createBucket(): Bucket {
    return { failures: 0, successes: 0, timeouts: 0, shortCircuits: 0 }
  }

  _lastBucket(): Bucket {
    return this._buckets[this._buckets.length - 1]
  }

  _executeCommand(command: Command): void {
    const self = this
    let timeout: number | null

    function increment(prop: 'successes' | 'failures' | 'timeouts') {
      return function () {
        if (!timeout) { return }

        const bucket = self._lastBucket()
        bucket[prop]++

        if (self._forced == null) {
          self._updateState()
        }

        clearTimeout(timeout)
        timeout = null
      }
    }

    timeout = setTimeout(increment('timeouts'), this.timeoutDuration)

    command(increment('successes'), increment('failures'))
  }

  _executeFallback(fallback: Fallback): void {
    fallback()

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
