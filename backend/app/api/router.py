"""API 路由聚合."""

from fastapi import APIRouter

from . import assets, ops, park, realtime

router = APIRouter()
router.include_router(park.router)
router.include_router(assets.router)
router.include_router(ops.router)
router.include_router(realtime.router)
