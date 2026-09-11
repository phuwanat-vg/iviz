# Changelog

## 0.2.0 — 2026-09-12

- **Navigation** panel on the right (shown or hidden from the top bar) and a status bar over the map, talking to Nav2 directly:
  - waypoints placed on the map, run with FollowWaypoints or NavigateThroughPoses, with an optional loop
  - a drawn path followed by the controller server (FollowPath)
  - **Pause / Resume** (cancels the goal and sends what is left) and **Cancel** (every goal on the robot)
  - progress: current waypoint, distance left, ETA, speed, recoveries
  - 2D Nav Goal now goes through NavigateToPose when possible, so it can be paused and canceled
  - **Save map** on the robot (Nav2 map_saver or slam_toolbox) or to this PC as `.yaml` + `.pgm`
  - needs foxglove_bridge started with `include_hidden:=true`; Setup explains what is missing
- ROS 2 action client over foxglove_bridge's hidden services, with built-in Jazzy definitions
- The mock bridge simulates Nav2 action servers and a map saver

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
