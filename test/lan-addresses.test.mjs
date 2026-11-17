import test from 'node:test'
import assert from 'node:assert/strict'

import { lanAddresses } from '../src/host/lan.js'

/*
 * 邀请条上那句地址，是对方唯一要抄的东西。装了 WSL2 的 Windows 上，
 * vEthernet 常常排在 WLAN 前面（os.networkInterfaces 的顺序没有保证），
 * 只取 addresses[0] 就会把 172.22.x.x 递给对方 —— 抄过去一直超时，
 * 而人看着「地址明明写对了」。这几条钉住排序与标记。
 */

const nic = (address, family = 'IPv4', internal = false) => ({ address, family, internal })

test('地址排序：真实网卡在前，WSL / Hyper-V 这类虚拟网卡压到后面（带 virtual 标记）', () => {
  const fake = {
    'vEthernet (WSL (Hyper-V firewall))': [nic('172.22.80.1')],
    'vEthernet (Default Switch)': [nic('172.28.16.1')],
    WLAN: [nic('10.0.51.18')],
    以太网: [nic('192.168.1.7'), nic('fe80::1', 'IPv6')],
  }
  const list = lanAddresses(fake)
  assert.deepEqual(
    list.map((row) => row.address),
    ['192.168.1.7', '10.0.51.18', '172.22.80.1', '172.28.16.1'],
    '192.168 最优先，其次 10.x，虚拟网卡的 172.x 垫底',
  )
  assert.deepEqual(
    list.map((row) => row.virtual),
    [false, false, true, true],
  )
  assert.equal(list[0].name, '以太网', '要能告诉用户这个地址是哪张网卡')
  assert.deepEqual(lanAddresses(fake), list, '同一份网卡表反复调用，顺序必须一样（截图才可复现）')
})

test('地址候选：APIPA、0.0.0.0、回环都不算 —— 那些地址另一台机器到不了', () => {
  const fake = {
    'Loopback Pseudo-Interface 1': [nic('127.0.0.1', 'IPv4', true)],
    '以太网 2': [nic('169.254.31.4')],
    '本地连接* 1': [nic('0.0.0.0')],
    Tailscale: [nic('100.101.102.103')],
  }
  const list = lanAddresses(fake)
  assert.deepEqual(
    list.map((row) => row.address),
    ['100.101.102.103'],
    '只剩那个既不是 APIPA 也不是回环的地址',
  )
  assert.equal(list[0].virtual, true, 'Tailscale 也是虚拟网卡：能用，但要让界面标出来')
})

test('本机真实网卡表：虚拟网卡不会排在真实网卡前面', () => {
  const real = lanAddresses()
  assert.ok(Array.isArray(real))
  const firstVirtual = real.findIndex((row) => row.virtual)
  if (firstVirtual >= 0) {
    assert.ok(
      real.slice(firstVirtual).every((row) => row.virtual),
      '一旦出现虚拟网卡，后面就不许再有真实网卡',
    )
  }
  assert.ok(
    real.every((row) => !/^169\.254\./.test(row.address)),
    'APIPA 不该出现在候选里',
  )
})
