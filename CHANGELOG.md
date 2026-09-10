# Changelog

## Unreleased

- ROS **service calls** over the same bridge connection (`FoxgloveConnection.callService`),
  and a Services section in the sidebar listing what the robot offers
- **Route mode** for drawing a route graph and building missions is present but
  **turned off in this build**; the toolbar button is greyed out. Flip
  `ROUTE_MODE_ENABLED` in `src/ui/App.ts` to bring it back
- Update endpoint points at the real repository, so installed copies can find
  new releases

## 0.1.0 — 2026-09-02

First release.

- Connects to `foxglove_bridge` over WebSocket; no ROS 2 needed on Windows
- 3D / 2D views, TF display, fixed frame and follow frame
- PointCloud2 and Livox CustomMsg with accumulation, colormaps and height clipping
- LaserScan, OccupancyGrid, Path, Odometry, Pose, Polygon layers
- 2D Nav Goal and 2D Pose Estimate tools
- In-app updates from GitHub Releases
