import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atr, ema, pearson, percentileRank, rsi, sma } from '../src/strategy/indicators.ts'
import { climbToStep, decimalsOf, floorToStep } from '../src/util/round.ts'

test('ema seeds with SMA and recurses correctly', () => {
  const out = ema([1, 2, 3, 4, 5], 3)
  assert.ok(Number.isNaN(out[0]))
  assert.ok(Number.isNaN(out[1]))
  assert.equal(out[2], 2)      // (1+2+3)/3
  assert.equal(out[3], 3)      // 4*0.5 + 2*0.5
  assert.equal(out[4], 4)      // 5*0.5 + 3*0.5
})

test('sma sliding window', () => {
  const out = sma([1, 2, 3, 4, 5, 6], 3)
  assert.equal(out[2], 2)
  assert.equal(out[3], 3)
  assert.equal(out[5], 5)
})

test('rsi is 100 on a pure uptrend and mid on alternating data', () => {
  const rising = Array.from({ length: 30 }, (_, i) => 100 + i)
  const outRising = rsi(rising, 14)
  assert.equal(Math.round(outRising[outRising.length - 1]), 100)

  const alt: number[] = []
  for (let i = 0; i < 40; i++) alt.push(100 + (i % 2 === 0 ? 1 : -1))
  const outAlt = rsi(alt, 14)
  const last = outAlt[outAlt.length - 1]
  assert.ok(last < 70, 'alternating RSI should be below 70, got ' + last)
})

test('atr equals constant range on uniform candles', () => {
  const candles = Array.from({ length: 30 }, (_, i) => ({
    t: i * 900000, o: 100, h: 101, l: 100, c: 100.5, v: 10
  }))
  const out = atr(candles, 14)
  // TR for every candle here: max(1, |101-100.5|, |100-100.5|) = 1
  assert.ok(Math.abs(out[out.length - 1] - 1) < 1e-9)
})

test('percentileRank counts values below', () => {
  assert.equal(percentileRank([1, 2, 3, 4], 3), 0.75)
  assert.equal(percentileRank([1, 2, 3, 4], 0), 0)
  assert.equal(percentileRank([1, 2, 3, 4], 5), 1)
})

test('pearson detects perfect correlation', () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9)
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-9)
})

test('step rounding helpers', () => {
  assert.equal(floorToStep(0.00012345, 0.0001), 0.0001)
  assert.equal(climbToStep(0.00012345, 0.0001), 0.0002)
  assert.equal(floorToStep(5.999, 0.5), 5.5)
  assert.equal(decimalsOf(0.00000001), 8)
  assert.equal(decimalsOf(0.01), 2)
})
