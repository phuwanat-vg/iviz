# Changelog

© 2026 phuwanat@IRiSH Lab SUT

## 0.7.0 — 2026-09-13

- **Missions on the Dashboard.** A Missions section at the top of the
  Dashboard lists the missions on the robot (title, name, what triggers them,
  the description on hover) with a **Run** button each, through mission_runner's
  `/mission/api` on the connection iViz already has. Nothing else is needed on
  the robot
- A mission that declares inputs opens a small form for them first. When
  starting it would cancel or interrupt the active run (its policy is
  `preempt`, `preempt_latest` or `interrupt_and_resume`), the form says so and
  the button reads **Run anyway**
- The **current run** card shows the mission, its status, the step it is on
  and where that step sits in the flow, distance and ETA from Nav2, and how long
  it has run, with **Pause** / **Resume** and **Stop**. Stop asks first, and
  offers to stop the queued and suspended runs too when there are any. The
  queue is listed underneath
- **Recent runs** lists the last ten with their result, error, start time and
  duration; click one for its steps, nested steps indented, pauses marked
- Updates live from `/mission/state` and `/mission/event`; when neither has
  said anything for a few seconds and the tab is on screen, `/api/status` is
  polled every 2 s. A toast says when a run starts, succeeds, fails or is
  canceled
- Without a connection, or without mission_runner on the robot, the section
  says which and why; the list and history can be folded away, which is saved
  with the settings
- A run the runner refuses (for example `reject_if_busy` while busy) now reports
  the runner's reason instead of a bare 409

## 0.6.0 — 2026-09-13

- **Request and answer topics per station.** Mission Builder and
  mission_runner can give a point its own pair (`/station/conveyor1/request`
  and `/answer`). iViz reads the runner's `request` events, which name the
  pair a question used, shows the question and answers it on that station's
  answer topic, so one iViz answers every station. The pair is listened on for
  the rest of the session, and the runner's `request.answered` clears the card
  and lists the answer
- Each card says which topic it answers on when that is not the Dashboard's.
  The Topics block lists the station pairs picked up so far
- **Answer by hand** has an **Answer topic**: left empty it uses the topic that
  came with the request, so answering a station by hand goes to the station
- The Dashboard's own pair (`/iviz/request`, `/iviz/answer`) works as before,
  for nodes that do not go through mission_runner
- The mock bridge takes `--stations`: two stations asking in turn on their own
  topics, announced on `/mission/event`, and it logs an answer sent to the
  wrong topic

## 0.5.2 — 2026-09-13

- Copyright: © 2026 phuwanat@IRiSH Lab SUT, shown in the **About** box and
  stamped on the installer and the executable's file properties

## 0.5.1 — 2026-09-13

- Setting a parameter no longer fails with *internal server error: parameter
  handler failed to send a response*. A whole number typed into a parameter
  the node declared as a double was offered as an integer, which the node
  refuses; iViz now sends each value with the type the robot gave it, and the
  field's tooltip says which numbers are doubles
- A set the bridge will not read back is reported as unconfirmed (amber)
  instead of as applied, and a set the node refuses puts the value the node
  really holds back in the field and says what usually causes it
- The mock bridge types its doubles and refuses an untyped one, like the real
  bridge

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
