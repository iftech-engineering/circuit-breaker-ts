import CircuitBreaker from '../circuit-breaker'

describe('CircuitBreaker', function () {

  let breaker: CircuitBreaker

  const success = function () {
    const command = () => null

    return breaker.run(command).catch(() => {})
  }

  const fail = function () {
    const command = () => {
      throw 'fail'
    }

    return breaker.run(command).catch(() => {})
  }

  const timeout = function () {
    const command = function () { }
    const ret = breaker.run(command).catch(() => {})
    
    jasmine.clock().tick(1000)
    jasmine.clock().tick(1000)
    jasmine.clock().tick(1000)
    return ret
  }

  beforeEach(function () {
    jasmine.clock().install()
    breaker = new CircuitBreaker()
  })

  afterEach(function () {
    jasmine.clock().uninstall()
  })

  describe('with a working service', function () {

    it('should run the command', async function () {
      const command = jasmine.createSpy()
      await breaker.run(command)

      expect(command).toHaveBeenCalled()
    })

    it('should be able to notify the breaker if the command was successful', async function () {
      await success()

      const bucket = breaker._lastBucket()
      expect(bucket.successes).toBe(1)
    })

    it('should be able to notify the breaker if the command failed', async function () {
      await fail()

      const bucket = breaker._lastBucket()
      expect(bucket.failures).toBe(1)
    })

    it('should record a timeout if not a success or failure', async function () {
      await timeout()

      const bucket = breaker._buckets[breaker._buckets.length - 2]
      expect(bucket.timeouts).toBe(1)
    })

    it('should not call timeout if there is a success', async function () {
      await success()
      jasmine.clock().tick(1000)
      jasmine.clock().tick(1000)
      jasmine.clock().tick(1000)
    
      const bucket = breaker._lastBucket()
      expect(bucket.timeouts).toBe(0)
    })

    it('should not call timeout if there is a failure', async function () {
      await fail()
      jasmine.clock().tick(1000)
      jasmine.clock().tick(1000)
      jasmine.clock().tick(1000)

      const bucket = breaker._lastBucket()
      expect(bucket.timeouts).toBe(0)
    })

    it('should not record a success when there is a timeout', async function () {
      const deferred = {} as { resolve: Function; reject: Function }
      const promise = new Promise((resolve, reject) => {
        deferred.resolve = resolve
        deferred.reject = reject
      })
      const command = function() {
        return promise
      }
      await Promise.all([
        breaker.run(command).catch(() => {}),
        void (function() {
          jasmine.clock().tick(1000)
          jasmine.clock().tick(1000)
          jasmine.clock().tick(1000)
          deferred.resolve()
        })(),
      ])

      const bucket = breaker._lastBucket()
      expect(bucket.successes).toBe(0)
    })

    it('should not record a failure when there is a timeout', async function () {
      const deferred = {} as { resolve: Function; reject: Function }
      const promise = new Promise((resolve, reject) => {
        deferred.resolve = resolve
        deferred.reject = reject
      })
      const command = function() {
        return promise
      }      
      await Promise.all([
        breaker.run(command).catch(() => {}),
        void (function() {
          jasmine.clock().tick(1000)
          jasmine.clock().tick(1000)
          jasmine.clock().tick(1000)
          deferred.reject('fail')
        })(),
      ])


      const bucket = breaker._lastBucket()
      expect(bucket.failures).toBe(0)
    })
  })

  describe('with a broken service', function () {

    beforeEach(function () {
      spyOn(breaker, 'isOpen').and.returnValue(true)
    })

    it('should not run the command', async function () {
      const command = jasmine.createSpy()
      await breaker.run(command).catch(() => {})

      expect(command).not.toHaveBeenCalled()
    })

    it('should run the fallback if one is provided', async function () {
      const command = jasmine.createSpy()
      const fallback = jasmine.createSpy()

      await breaker.run(command).catch(fallback)

      expect(fallback).toHaveBeenCalled()
    })

    it('should record a short circuit', async function () {
      const command = jasmine.createSpy()
      await breaker.run(command).catch(() => {})

      expect(command).not.toHaveBeenCalled()

      const bucket = breaker._lastBucket()
      expect(bucket.shortCircuits).toBe(1)
    })
  })

  describe('isOpen', function () {

    it('should be false if errors are below the threshold', async function () {
      breaker.errorThreshold = 75

      await Promise.all([fail(), fail(), fail(), success()])

      expect(breaker.isOpen()).toBe(false)
    })

    it('should be true if errors are above the threshold', async function () {
      breaker.errorThreshold = 75

      await Promise.all([fail(), fail(), fail(), fail(), fail(), success()])

      expect(breaker.isOpen()).toBe(true)
    })

    it('should be true if timeouts are above the threshold', async function () {
      breaker.errorThreshold = 25
      breaker.volumeThreshold = 1

      await Promise.all([timeout(), timeout(), success()])

      expect(breaker.isOpen()).toBe(true)
    })

    it('should maintain failed state after window has passed', async function () {
      breaker.errorThreshold = 25
      breaker.volumeThreshold = 1

      await Promise.all([fail(), fail(), fail(), fail()])

      jasmine.clock().tick(11001)

      await fail()

      expect(breaker.isOpen()).toBe(true)
    })

    it('should retry after window has elapsed', async function () {
      await Promise.all([fail(), fail(), fail(), fail()])

      jasmine.clock().tick(11001)

      const command = jasmine.createSpy()
      await breaker.run(command)

      expect(command).toHaveBeenCalled()
    })

    it('should include errors within the current time window', async function () {
      breaker.errorThreshold = 75

      await Promise.all([fail(), fail(), fail(), fail(), fail(), success()])

      jasmine.clock().tick(1001)

      expect(breaker.isOpen()).toBe(true)
    })

    it('should not be broken without having more than minumum number of errors', async function () {
      breaker.errorThreshold = 25
      breaker.volumeThreshold = 1

      await fail()

      expect(breaker.isOpen()).toBe(false)
    })
  })

  describe('logging', function () {
    let openSpy: jasmine.Spy
    let closeSpy: jasmine.Spy

    beforeEach(function () {
      openSpy = jasmine.createSpy()
      closeSpy = jasmine.createSpy()

      breaker.volumeThreshold = 1
      breaker.onCircuitOpen = openSpy
      breaker.onCircuitClose = closeSpy
    })

    it('should call the onCircuitOpen method when a failure is recorded', async function () {      
      await Promise.all([fail(), fail()])
      expect(openSpy).toHaveBeenCalled()
    })

    it('should call the onCircuitClosed method when the break is successfully reset', async function () {
      await Promise.all([fail(), fail(), fail(), fail()])

      jasmine.clock().tick(11001)

      await success()

      expect(closeSpy).toHaveBeenCalled()
    })
  })

  describe('forceClose', function () {

    it('should bypass threshold checks', async function () {
      await Promise.all([fail(), fail(), fail(), fail(), fail(), fail()])

      breaker.forceClose()

      const command = jasmine.createSpy()
      await breaker.run(command)

      expect(command).toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(false)
    })

    it('should not collect stats', async function () {
      await Promise.all([fail(), fail(), fail(), fail(), fail(), fail()])

      breaker.forceClose()
      await Promise.all([success(), success(), success(), success(), success()])

      const command = jasmine.createSpy()
      await breaker.run(command)

      expect(command).toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(false)
    })
  })

  describe('forceOpen', function () {

    it('should bypass threshold checks', async function () {
      await Promise.all([success(), success(), success(), success(), success(), success()])

      breaker.forceOpen()

      const command = jasmine.createSpy()
      await breaker.run(command).catch(() => {})

      expect(command).not.toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(true)
    })

    it('should not collect stats', async function () {
      await Promise.all([success(), success(), success(), success(), success(), success()])

      breaker.forceOpen()
      await Promise.all([fail(), fail(), fail(), fail(), fail()])

      const command = jasmine.createSpy()
      await breaker.run(command).catch(() => {})

      expect(command).not.toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(true)
    })
  })

  describe('unforce', function () {

    it('should recover from a force-closed circuit', async function () {
      await Promise.all([fail(), fail(), fail(), fail(), fail(), fail()])

      breaker.forceClose()
      breaker.unforce()

      const command = jasmine.createSpy()
      await breaker.run(command).catch(() => {})

      expect(command).not.toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(true)
    })

    it('should recover from a force-open circuit', async function () {
      await Promise.all([success(), success(), success(), success(), success(), success()])

      breaker.forceOpen()
      breaker.unforce()

      const command = jasmine.createSpy()
      await breaker.run(command)

      expect(command).toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(false)
    })

  })
})
