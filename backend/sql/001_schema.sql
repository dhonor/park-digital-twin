-- 园区级数字孪生 PostGIS 初始化
-- 设计取舍: 园区级数据量（万级要素 / 千级设备）用「统一要素表 + jsonb 属性」
-- 比一层一表更好维护; 出现瓶颈后再按图层拆表或切矢量瓦片。

CREATE EXTENSION IF NOT EXISTS postgis;

-- 园区元数据（整体作为一个 json 文档, 与 API 响应同构）
CREATE TABLE IF NOT EXISTS dt_park (
    id       text PRIMARY KEY,
    detail   jsonb NOT NULL
);

-- 统一要素表：一个图层一段 geometry，属性走 jsonb
-- 几何按 XYZ 存储：园区要素都带高程（建筑基面、设备所在楼层、管线埋深），
-- 只存 2D 会导致设备点位贴地、楼层信息丢失。
CREATE TABLE IF NOT EXISTS dt_layer_feature (
    layer_key text NOT NULL,
    feat_id   text NOT NULL,
    props     jsonb NOT NULL DEFAULT '{}'::jsonb,
    geom      geometry(GeometryZ, 4326) NOT NULL,
    PRIMARY KEY (layer_key, feat_id)
);

-- 兼容早期按 2D 建的库（CREATE TABLE IF NOT EXISTS 不会改已有列类型）
-- 依赖该列的视图必须先摘掉, 改完类型再重建（见文件末尾）
DROP VIEW IF EXISTS v_device_point;
ALTER TABLE dt_layer_feature
    ALTER COLUMN geom TYPE geometry(GeometryZ, 4326) USING ST_Force3D(geom);

CREATE INDEX IF NOT EXISTS idx_dt_layer_feature_geom  ON dt_layer_feature USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_dt_layer_feature_layer ON dt_layer_feature (layer_key);
-- 属性检索（设备状态 / 建筑类型等），按需加表达式索引
CREATE INDEX IF NOT EXISTS idx_dt_layer_feature_status ON dt_layer_feature ((props ->> 'status'));

-- 楼栋明细：分层/房间/能耗，与几何解耦，前端点开才拉
CREATE TABLE IF NOT EXISTS dt_building_detail (
    id     text PRIMARY KEY,
    detail jsonb NOT NULL
);

-- 告警
CREATE TABLE IF NOT EXISTS dt_alarm (
    id     text PRIMARY KEY,
    ts     timestamptz NOT NULL DEFAULT now(),
    detail jsonb NOT NULL
);

-- 确认状态落库: 多副本下 ack 才会在所有副本生效, 重启也不丢
ALTER TABLE dt_alarm ADD COLUMN IF NOT EXISTS acked_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_dt_alarm_acked ON dt_alarm (acked_at);

CREATE INDEX IF NOT EXISTS idx_dt_alarm_ts ON dt_alarm (ts DESC);

-- ---------------------------------------------------------------
-- 以下两表为「演进阶段」预留：设备台账与读数时序
-- 演示阶段设备仍在 dt_layer_feature 里；接入真实 IoT 后迁到这里，
-- 读数建议按月分区，或直接上 TimescaleDB。
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dt_device (
    id          text PRIMARY KEY,
    building_id text,
    dtype       text,
    status      text,
    geom        geometry(PointZ, 4326),
    props       jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dt_device_geom ON dt_device USING GIST (geom);

CREATE TABLE IF NOT EXISTS dt_device_reading (
    device_id text NOT NULL,
    ts        timestamptz NOT NULL,
    metric    text NOT NULL,
    value     double precision NOT NULL,
    PRIMARY KEY (device_id, ts, metric)
);

-- 便于对接 BI / GeoServer 的视图：园区设备点位
CREATE OR REPLACE VIEW v_device_point AS
SELECT
    feat_id                                              AS device_id,
    props ->> 'name'                                     AS name,
    props ->> 'type'                                     AS dtype,
    props ->> 'status'                                   AS status,
    props ->> 'building_id'                              AS building_id,
    geom
FROM dt_layer_feature
WHERE layer_key = 'devices';

COMMENT ON TABLE dt_layer_feature IS '数字孪生统一要素表（LOD 由服务层生成，不落多套数据）';
