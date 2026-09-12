# Changelog

## 0.5.0 — 2026-09-13

- **Parameters** tab: read every parameter of every node and set it on the
  running robot, for trying values. Nothing is written to a file
- A value the node clamps or refuses is reported with what it kept instead
- **Changed parameters (N)** summarises everything touched in this session
  with its earlier value, puts one or all of them back, and hands the list
  over as `ros2 param set` lines
- The mock bridge serves parameters, and clamps `max_vel_x` at 1.0 so the
  refused-value path can be tried

## 0.4.0 — 2026-09-13

- Answering what the robot asks no longer needs mission_runner. Requests
  arrive on `/iviz/request` and answers go back on `/iviz/answer`, both
  `std_msgs/String` carrying JSON, so any node can ask and anything can
  answer. iViz stands in until the real answering node exists, and is dropped
  in favour of it without the asking side changing ([README](README.md#asking-for-a-decision))
- The Dashboard lists every pending request with a button per option, shows it
  over the map, and **Answer by hand** sends any answer for any id, even one
  iViz never saw. Both topics are set in that tab
- The mock bridge takes `--ask` (a question every 25 s) and `--auto-answer`
  (answers iViz's own requests, as a node of yours would)

## 0.3.0 — 2026-09-12

- The side panel is now tabbed: **Navigation**, **Services**, **Dashboard**,
  switched in its header or with **Panel** in the top bar
- **Services** tab: call any service the robot offers. The request form is
  generated from the schema the bridge sends, the response is shown as it comes
  back, and a filled-in call can be pinned to the Dashboard as a button
- **Dashboard** tab: answer what the robot asks. mission_runner's `ask_user`
  question arrives on `/mission/event` and the buttons answer it through
  `/mission/answer` or the `/mission/api` tunnel, which lets the step continue.
  A pending question also appears over the map, with its default option and a
  countdown; answered questions are listed with it. Pinned service buttons live
  here too
- `npm run mock -- --prompt` asks a question every 20 s and serves
  `/mission/answer`, so the Dashboard works without mission_runner

## 0.2.4 — 2026-09-12

- Works before AMCL is localized. Until an initial pose is set there is no
  map → odom transform, so the map frame belongs to no TF tree and the map
  could not be shown, which left nothing to click a pose estimate on. iViz
  now takes the fixed frame from the map message itself when TF does not know
  that frame yet, and the frame menu lists frames seen in data as well as in TF
- **2D Pose Estimate** is always sent in the global frame. A click is in the
  fixed frame, so the point is transformed when TF allows it, and iViz says so
  when it cannot (AMCL rejects an initial pose that is not in the map frame)
- The Navigation panel shows **Not localized** with what to do about it while
  the map and the robot are not connected by TF
- `npm run mock -- --no-localization` starts the mock without map → odom and
  publishes it once iViz sends an initial pose, like AMCL

## 0.2.3 — 2026-09-12

- The map arrives on its own. `/map` is latched, so a client that connects
  after it was published never receives it, which is why it only showed up
  after RViz2 had run. When a grid layer stays empty, iViz now asks the
  robot's `nav_msgs/srv/GetMap` service (map_server or slam_toolbox) instead.
  Save to this PC uses the same service
- The topic list only shows topics that something publishes right now, from
  the bridge's connection graph. **View → Show inactive topics** brings the
  rest back
- Disconnecting clears the topics, the services, the layers and the frames,
  so nothing from the old robot is left on screen. Layer choices come back
  from the settings on reconnect

## 0.2.2 — 2026-09-12

- Fix: Follow path failed with "FollowPath called with goal_checker name
  general_goal_checker ... which does not exist" on robots whose plugins are
  named differently. The controller, goal checker and progress checker names
  are now empty by default, so controller_server uses the one it loaded.
  Names saved by 0.2.0 and 0.2.1 are cleared once; set them in
  Navigation → Setup when controller_server loads several

## 0.2.1 — 2026-09-12

- Fix: waypoints, paths and nav goals reached Nav2 empty ("Path is empty",
  empty waypoints, a goal at 0,0 with no frame). foxglove_bridge describes
  action types with the goal, result and feedback fields flattened, and iViz
  only filled the nested fields. It now fills both, and reads progress and
  error messages in either shape
- **Robot pose** button adds the robot's current position and heading as a waypoint
- The mock bridge advertises action types flattened, like the real bridge

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
