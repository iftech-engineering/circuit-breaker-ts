import CircuitBreaker from '../circuit-breaker'

describe('CircuitBreaker', function () {

  let breaker: CircuitBreaker

  const success = function () {
    const command = function (success: Function) {
      success()
    }

    breaker.run(command)
  }

  const fail = function () {
    const command = function (success: Function, failed: Function) {
      failed()
    }

    breaker.run(command)
  }

  const timeout = function () {
    const command = function () { }
    breaker.run(command)

    jasmine.clock().tick(1000)
    jasmine.clock().tick(1000)
    jasmine.clock().tick(1000)
  }

  beforeEach(function () {
    jasmine.clock().install()
    breaker = new CircuitBreaker()
  })

  afterEach(function () {
    jasmine.clock().uninstall()
  })

  describe('with a working service', function () {

    it('should run the command', function () {
      const command = jasmine.createSpy()
      breaker.run(command)

      expect(command).toHaveBeenCalled()
    })

    it('should be able to notify the breaker if the command was successful', function () {
      success()

      const bucket = breaker._lastBucket()
      expect(bucket.successes).toBe(1)
    })

    it('should be able to notify the breaker if the command failed', function () {
      fail()

      const bucket = breaker._lastBucket()
      expect(bucket.failures).toBe(1)
    })

    it('should record a timeout if not a success or failure', function () {
      timeout()

      const bucket = breaker._buckets[breaker._buckets.length - 2]
      expect(bucket.timeouts).toBe(1)
    })

    it('should not call timeout if there is a success', function () {
      success()

      jasmine.clock().tick(1000)
      jasmine.clock().tick(1000)
      jasmine.clock().tick(1000)

      const bucket = breaker._lastBucket()
      expect(bucket.timeouts).toBe(0)
    })

    it('should not call timeout if there is a failure', function () {
      fail()

      jasmine.clock().tick(1000)
      jasmine.clock().tick(1000)
      jasmine.clock().tick(1000)

      const bucket = breaker._lastBucket()
      expect(bucket.timeouts).toBe(0)
    })

    it('should not record a success when there is a timeout', function () {
      const command = function (success: Function) {
        jasmine.clock().tick(1000)
        jasmine.clock().tick(1000)
        jasmine.clock().tick(1000)

        success()
      }

      breaker.run(command)

      const bucket = breaker._lastBucket()
      expect(bucket.successes).toBe(0)
    })

    it('should not record a failure when there is a timeout', function () {
      const command = function (success: Function, fail: Function) {
        jasmine.clock().tick(1000)
        jasmine.clock().tick(1000)
        jasmine.clock().tick(1000)

        fail()
      }

      breaker.run(command)

      const bucket = breaker._lastBucket()
      expect(bucket.failures).toBe(0)
    })
  })

  describe('with a broken service', function () {

    beforeEach(function () {
      spyOn(breaker, 'isOpen').and.returnValue(true)
    })

    it('should not run the command', function () {
      const command = jasmine.createSpy()
      breaker.run(command)

      expect(command).not.toHaveBeenCalled()
    })

    it('should run the fallback if one is provided', function () {
      const command = jasmine.createSpy()
      const fallback = jasmine.createSpy()

      breaker.run(command, fallback)

      expect(fallback).toHaveBeenCalled()
    })

    it('should record a short circuit', function () {
      const command = jasmine.createSpy()
      breaker.run(command)

      expect(command).not.toHaveBeenCalled()

      const bucket = breaker._lastBucket()
      expect(bucket.shortCircuits).toBe(1)
    })
  })

  describe('isOpen', function () {

    it('should be false if errors are below the threshold', function () {
      breaker.errorThreshold = 75

      fail()
      fail()
      fail()
      success()

      expect(breaker.isOpen()).toBe(false)
    })

    it('should be true if errors are above the threshold', function () {
      breaker.errorThreshold = 75

      fail()
      fail()
      fail()
      fail()
      fail()
      success()

      expect(breaker.isOpen()).toBe(true)
    })

    it('should be true if timeouts are above the threshold', function () {
      breaker.errorThreshold = 25
      breaker.volumeThreshold = 1

      timeout()
      timeout()
      success()

      expect(breaker.isOpen()).toBe(true)
    })

    it('should maintain failed state after window has passed', function () {
      breaker.errorThreshold = 25
      breaker.volumeThreshold = 1

      fail()
      fail()
      fail()
      fail()

      jasmine.clock().tick(11001)

      fail()

      expect(breaker.isOpen()).toBe(true)
    })

    it('should retry after window has elapsed', function () {
      fail()
      fail()
      fail()
      fail()

      jasmine.clock().tick(11001)

      const command = jasmine.createSpy()
      breaker.run(command)

      expect(command).toHaveBeenCalled()
    })

    it('should include errors within the current time window', function () {
      breaker.errorThreshold = 75

      fail()
      fail()
      fail()
      fail()
      fail()
      success()

      jasmine.clock().tick(1001)

      expect(breaker.isOpen()).toBe(true)
    })

    it('should not be broken without having more than minumum number of errors', function () {
      breaker.errorThreshold = 25
      breaker.volumeThreshold = 1

      fail()

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

    it('should call the onCircuitOpen method when a failure is recorded', function () {
      fail()
      fail()

      expect(openSpy).toHaveBeenCalled()
    })

    it('should call the onCircuitClosed method when the break is successfully reset', function () {
      fail()
      fail()
      fail()
      fail()

      jasmine.clock().tick(11001)

      success()

      expect(closeSpy).toHaveBeenCalled()
    })
  })

  describe('forceClose', function () {

    it('should bypass threshold checks', function () {
      fail()
      fail()
      fail()
      fail()
      fail()
      fail()

      breaker.forceClose()

      const command = jasmine.createSpy()
      breaker.run(command)

      expect(command).toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(false)
    })

    it('should not collect stats', function () {
      fail()
      fail()
      fail()
      fail()
      fail()
      fail()

      breaker.forceClose()
      success()
      success()
      success()
      success()
      success()

      const command = jasmine.createSpy()
      breaker.run(command)

      expect(command).toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(false)
    })
  })

  describe('forceOpen', function () {

    it('should bypass threshold checks', function () {
      success()
      success()
      success()
      success()
      success()
      success()

      breaker.forceOpen()

      const command = jasmine.createSpy()
      breaker.run(command)

      expect(command).not.toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(true)
    })

    it('should not collect stats', function () {
      success()
      success()
      success()
      success()
      success()
      success()

      breaker.forceOpen()
      fail()
      fail()
      fail()
      fail()
      fail()

      const command = jasmine.createSpy()
      breaker.run(command)

      expect(command).not.toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(true)
    })
  })

  describe('unforce', function () {

    it('should recover from a force-closed circuit', function () {
      fail()
      fail()
      fail()
      fail()
      fail()
      fail()

      breaker.forceClose()
      breaker.unforce()

      const command = jasmine.createSpy()
      breaker.run(command)

      expect(command).not.toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(true)
    })

    it('should recover from a force-open circuit', function () {
      success()
      success()
      success()
      success()
      success()
      success()

      breaker.forceOpen()
      breaker.unforce()

      const command = jasmine.createSpy()
      breaker.run(command)

      expect(command).toHaveBeenCalled()
      expect(breaker.isOpen()).toBe(false)
    })

  })
})
