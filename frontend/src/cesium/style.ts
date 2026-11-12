import type { DeviceStatus } from '../types'

/** 建筑体块配色: 与业务类型绑定, LOD0 丢失 color 属性时按 type 兜底 */
export const BUILDING_HEX: Record<string, string> = {
  office: '#2E7DF7',
  lab: '#7C5CFF',
  datacenter: '#00C2A8',
  service: '#F0A63A',
  conference: '#3AA0F0',
  energy: '#F2653A',
  canteen: '#56C271',
  residential: '#4FA8E0',
  gym: '#9AD34F',
  parking: '#8A94A6',
}

export const STATUS_HEX: Record<DeviceStatus, string> = {
  normal: '#3FC6FF',
  warning: '#FFB545',
  alarm: '#FF5C5C',
  offline: '#5D7080',
}

export const STATUS_LABEL: Record<DeviceStatus, string> = {
  normal: '正常',
  warning: '预警',
  alarm: '告警',
  offline: '离线',
}

export const GREEN_HEX: Record<string, string> = {
  lawn: '#1B4A2C',
  plaza: '#1E2C3A',
  water: '#0F4468',
}

export const PIPE_HEX: Record<string, string> = {
  water: '#2E9BFF',
  sewage: '#8A6B4A',
  power: '#F0A63A',
  network: '#00C2A8',
}

export const DEVICE_TYPE_LABEL: Record<string, string> = {
  hvac: '暖通机组',
  meter: '智能电表',
  water: '远传水表',
  env: '环境传感器',
  camera: '安防摄像机',
  elevator: '电梯',
  fire: '消防探测器',
  charge: '充电桩',
  parking: '车位感知',
  light: '智能照明',
}
