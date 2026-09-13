# iViz

Lightweight ROS 2 visualization for Windows. iViz connects to
[`foxglove_bridge`](https://github.com/foxglove/ros-foxglove-bridge) running on
the robot (Raspberry Pi 5) over a single WebSocket, so nothing ROS-related has
to be installed on the Windows side and no remote desktop is needed.

Built with Tauri 2 (WebView2) + TypeScript + three.js.

## Download

Grab the latest `iViz_*_x64-setup.exe` from
[Releases](https://github.com/phuwanat-vg/iviz/releases). Installed copies check
for new versions themselves, so this is a one-time download.

## Features

- 3D and 2D (top-down) views, ROS coordinate convention (x forward, y left, z up)
- Point clouds: `sensor_msgs/PointCloud2` and `livox_ros_driver2/CustomMsg`
  - color by intensity / height / RGB / flat, turbo / viridis / rainbow / gray colormaps
  - **accumulate frames** into a persistent map in the fixed frame (for FAST-LIO2 `/cloud_registered`)
  - decimation and point caps to keep WiFi and GPU load in check
- `sensor_msgs/LaserScan`, `nav_msgs/OccupancyGrid` (map & costmap palettes), `nav_msgs/Path`,
  `nav_msgs/Odometry`, `geometry_msgs/PoseStamped`, `geometry_msgs/PoseWithCovarianceStamped`,
  `geometry_msgs/PolygonStamped`
- TF tree display with frame names, selectable fixed frame, follow-frame camera
- Nav2 tools: **2D Nav Goal** and **2D Pose Estimate** by click-and-drag, **waypoints**
  (FollowWaypoints or NavigateThroughPoses, optional loop), **follow a drawn path**
  (FollowPath), **pause / resume / cancel**, and **save the map** on the robot or on this PC
  ([below](#navigation))
- **Services** tab: call any service the robot offers, with the request form
  built from its schema, and pin a filled-in call to the Dashboard as a button
- **Dashboard** tab: answer mission_runner's questions with a button, on the
  panel and over the map ([below](#services-and-the-dashboard))
- Per-topic Hz and total bandwidth readout; settings persist between runs
- The topic list shows only topics that something publishes, from the bridge's
  connection graph; **View → Show inactive topics** lists the rest
- Auto-reconnect
- **Route mode**: draw the lanes the robot may drive and say what happens at
  each stop, over the same connection ([below](#route-mode))

## Robot side (Raspberry Pi)

```bash
sudo apt install ros-$ROS_DISTRO-foxglove-bridge
ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765 include_hidden:=true
```

Add it to your Nav2 / FAST-LIO2 bring-up launch file so it starts with the robot.
No RViz2, no VNC. `include_hidden:=true` exposes the hidden services and topics
behind Nav2 actions, which the [Navigation](#navigation) tools need.

If a point cloud is too heavy for WiFi, throttle it on the Pi with `topic_tools`
and subscribe to the throttled topic in iViz:

```bash
sudo apt install ros-$ROS_DISTRO-topic-tools
ros2 run topic_tools throttle messages /cloud_registered 2.0 /iviz/cloud_registered
```

Custom messages such as `livox_ros_driver2/msg/CustomMsg` work as long as the
package is sourced in the shell that launches `foxglove_bridge` (the bridge ships
the message definition to iViz at runtime).

## Windows side

Requirements: Node.js 22+, Rust (for the desktop build), WebView2 (included in Windows 11).

```bash
npm install
```

Run in the browser (fast iteration):

```bash
npm run dev
```

Run as a desktop window:

```bash
npm run tauri dev
```

Build the installer (`src-tauri/target/release/bundle/nsis/iViz_*.exe`):

```bash
npm run tauri build
```

Then enter `ws://<pi-ip>:8765` in the top bar and press **Connect**.

## Develop without a robot

A mock `foxglove_bridge` simulates a robot driving around a room and publishes
TF, odometry, laser scan, a FAST-LIO2 style registered point cloud, a Livox
`CustomMsg` cloud, a static map, a rolling local costmap, a plan, a footprint
and an AMCL pose. It also logs any goal / initial pose iViz publishes.

It simulates Nav2 too (`tools/mock-nav2.ts`): the four action servers the
Navigation tools use and `/map_saver/save_map`. The robot drives in a circle
until it receives a goal, then drives to it, so waypoints, paths, pause, resume
and cancel can be tried end to end.

```bash
npm run mock
```

Connect iViz to `ws://localhost:8765`.

### Route mode without a robot

The mock bridge also stands in for `mission_runner`'s ROS node, so Route mode
can be developed without ROS. It advertises `/mission/api`
(`mission_msgs/srv/Api`) exactly as the robot does and forwards every call to a
runner's HTTP API, and republishes that runner's event stream on
`/mission/state` and `/mission/event`.

Start a simulated runner (it needs no ROS), then the bridge:

```bash
mission_runner run --sim --home ~/.mission-dev --port 8080
MISSION_RUNNER_URL=http://127.0.0.1:8080 npm run mock
```

`MISSION_RUNNER_URL` defaults to `http://127.0.0.1:8080`. When no runner is
listening, iViz simply reports Route mode as unavailable and keeps working as a
viewer.

## Route mode

**Route** in the top bar swaps the layer sidebar for the route editor and turns
the 3D view into an editing surface. Two things live on the map, and they are
different on purpose:

- **The route graph** belongs to the *map*, not to a mission: the points and
  lanes the robot is allowed to use, shared by every mission. Points are sites
  in `sites.json`, lanes are that map's `edges`.
- **A mission** is an ordered list of **stops**. A stop is a point on the graph
  plus the actions to perform on arrival. It is saved as ordinary `mission/1`
  JSON: each stop compiles to a `nav.follow_route` step followed by its action
  steps, so triggers, interrupts, retries and the Python export keep working.

They are two documents on the robot, but one button here: **Save to the robot**
sends whatever is unsaved and says which — *Save mission*, *Save map* or *Save
both* — with a sentence above it naming what has not been sent yet. (This
replaces the old separate *Save map data* and *Deploy* buttons.)

Because every drive is `nav.follow_route`, the robot only travels on the lanes
that were drawn.

### The panel

The panel is ordered the way the job is done: what is running, the stops, the
selected thing, saving. A section with nothing in it is not drawn — in its
place comes a card saying what to do next. On an empty map that card is the
three numbered steps (draw the points, connect them, put them in order), each
with its key and a button that arms the tool; with points but no mission it
offers the mission list; with a mission but no stops it offers the
pick-a-point-on-the-map button.

The header shows the mission's title, one sentence about what the robot is
doing, and **Run** as the prominent button with Pause and Stop beside it;
which mission, which map, what the view draws and *Reload from the robot* live
behind the small menu next to the title. Each stop is a card with its number,
its destination and its actions indented underneath. Errors are sentences, not
status codes: the technical text is folded away behind **Details**.

### Tools

The tool bar at the bottom of the view gives each tool an icon, a word and its
key on a comfortable button, fills in the armed one, and explains it in one
muted line underneath — including, while Link is dragging, what it is about to
connect ("Home ↔ Conveyor1 — let go to draw it"). Points and lanes are easier
to hit (an 18-pixel picking tolerance, a pointer cursor on hover) and what is
selected is unmistakable.

| Key | Tool | Behaviour |
|---|---|---|
| `V` | Select | Click a point, lane or stop to select. Drag a point to move it, drag its heading arrow to turn it. `Del` deletes the selection, with a confirmation when something references it. |
| `N` | Point | Click the floor to drop a point, drag before releasing to set its heading, then type its name inline. A point dropped on a lane splits that lane in two. |
| `L` | Link | Drag from one point to another to draw a lane. Hold Shift for a one-way lane. Clicking a lane selects it. |

`Esc` returns to Select, `Ctrl+Z` / `Ctrl+Y` undo and redo, and one drag is one
undo step. A route tool only takes the left mouse button, so middle-drag pan
and right-drag orbit keep working: editing works in 3D as well as in the 2D
top-down view Route mode starts in.

### What the robot needs

Route mode talks to `mission_runner` over the connection iViz already has — no
second connection, no HTTP from Windows:

- `mission_runner` running on the robot (a systemd service), and the
  `mission_msgs` package built, so it can advertise the ROS service
  `/mission/api` (`mission_msgs/srv/Api`) and publish `/mission/state` and
  `/mission/event`;
- `foxglove_bridge` launched with services enabled (the default), so that
  service reaches iViz.

When the bridge does not advertise the `services` capability, or `/mission/api`
is absent, Route mode is disabled with that reason and iViz stays a viewer.

**The robot does not need iViz.** `mission_runner` starts at boot, arms its
triggers and runs missions headless whether or not anybody is connected;
iViz is one optional window onto it.

### Not built yet

Zone drawing, route preview (`POST /api/preview/route`), the dry-run animation
and the live costmap/scan layers are deliberately left out of this version.

## Navigation

The **Navigation** panel on the right of the map and the status bar over the
map drive Nav2 directly. They do not need mission_runner. Show or hide the
panel with **Navigation** in the top bar or the ✕ in its header; the status bar
keeps showing while a task runs, even with the panel hidden. The topics and
services behind actions (`/_action/...`) are left out of the sidebar lists.

| Tool | How | Nav2 interface |
|---|---|---|
| 2D Nav Goal | top bar, click and drag | `/navigate_to_pose` action, or `/goal_pose` when actions are hidden |
| Waypoints | **Place**, click on the map (drag sets the heading), or **Robot pose** for where the robot stands; then **Start** | `/follow_waypoints` stops at each one, `/navigate_through_poses` drives through them |
| Follow path | **Draw**, click along the route, **Follow path** | `/follow_path` on the controller server, without the planner |
| Pause / Resume | status bar | cancels the goal and keeps the task; Resume sends what is left |
| Cancel | status bar | cancels every goal on the four action servers, whoever sent it |
| Save on robot | Map | `nav2_msgs/srv/SaveMap` (map_saver) or `slam_toolbox/srv/SaveMap` |
| Fetch the map | automatic | `nav_msgs/srv/GetMap`, when the latched `/map` topic stays silent |
| Save to this PC | Map | writes `<name>.yaml` and `<name>.pgm` from `/map`, like map_saver |

Waypoints and the path are kept between runs. While a tool is active,
Backspace removes the last point and Esc ends the tool.

Nav2 has no pause of its own, so **Pause** stops the robot by canceling its
goal. **Resume** continues with the waypoint the robot was heading to, or with
the path from the point nearest to where the robot stands (the robot frame is
set in Setup). Goals are stamped with time zero, which tf2 reads as "the latest
transform", so a clock difference between the PC and the robot does not get
them rejected.

### Before the robot is localized

AMCL waits for an initial pose, and until it has one it publishes no
map -> odom transform. The map frame then belongs to no TF tree, so iViz shows
the view in the frame the map message names, draws the map, and marks the
Navigation panel **Not localized**. Click **2D Pose Estimate** on the map and
drag for the heading; the pose goes out in the map frame, the only frame AMCL
accepts. The robot and the sensor layers appear once map -> odom starts
flowing.

### What the robot needs

ROS 2 actions reach the bridge as hidden services and topics, such as
`/navigate_to_pose/_action/send_goal` and `/navigate_to_pose/_action/status`.
foxglove_bridge only advertises them when started with `include_hidden:=true`:

```bash
ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765 include_hidden:=true
```

Without it, 2D Nav Goal still works over `/goal_pose`, the other tools stay
disabled, and **Navigation → Setup** lists what is missing.

Saving the map on the robot needs a map saver service. Nav2's is started with:

```bash
ros2 launch nav2_map_server map_saver_server.launch.py
```

A relative map name is written wherever map_saver runs, so an absolute path
such as `/home/pi/maps/office` is safer. Action names and the FollowPath
controller, goal checker and progress checker names are in **Navigation →
Setup**. The action names match nav2_bringup on Jazzy. The plugin names are
empty by default, which makes controller_server use the one it loaded; fill
them in only when it loads several (its error message lists the names).

## Services and the Dashboard

The side panel on the right has three tabs, switched in its header or with the
**Panel** button in the top bar.

**Services** lists what the robot offers and calls any of it: pick a service,
fill in the form iViz builds from the schema the bridge sends, press **Call**
and read the response. **Pin** puts that filled-in call on the Dashboard as a
button, so clearing a costmap or starting a routine is one click. Pins are
saved with the settings. The hidden services behind ROS 2 actions are left out
of the list unless you ask for them.

**Dashboard** answers what the robot asks. A bridge client cannot serve ROS
services, so nothing on the robot can call iViz directly; mission_runner does
the waiting there instead. Its `ask_user` step publishes the question on
`/mission/event` and blocks until an answer arrives through `/mission/answer`
(`mission_msgs/srv/Answer`) or the `/mission/api` tunnel, and that is what
these buttons send. A pending question also appears over the map, with the
default option emphasised and a countdown when the step has a timeout;
answered questions are listed underneath.

Without mission_runner the Dashboard says so, and the pinned buttons keep
working. To try it without a robot, `npm run mock -- --prompt` asks a question
every 20 seconds and serves `/mission/answer` the way the runner does.

## Parameters

The **Parameters** tab reads every parameter of every node through the bridge
and sets them on the running robot. Nothing is written to a file: this is for
trying a value while watching the robot, the way `ros2 param set` does, and a
node restart brings its old value back.

- **Load parameters** reads them all; the search box filters by node or name,
  and each node is a group you open.
- Editing a value sends it at once. The box turns green when the node took it,
  red when it did not (iViz says what the node kept instead, since a node may
  clamp or refuse a value), and amber when the bridge would not read the value
  back to confirm it.
- Each value is sent with the type the robot reported, so a whole number typed
  into a parameter the node declared as a double still goes in as a double.
  Hold the pointer over a field to see the type. Without this a node refuses
  the value and the bridge answers *internal server error: parameter handler
  failed to send a response*.
- **Changed parameters (N)** is the summary of everything touched in this
  session, with what each one was before, a button to put one back, one to put
  them all back, and the same list as `ros2 param set` lines to keep.

It needs a bridge with the `parameters` capability, which foxglove_bridge has
by default. Updates made by anyone else appear here too.

## Asking for a decision

Some steps need a person: the robot arrives at a station and waits until
someone confirms the part is in place. iViz answers that, and it answers it in
a way that something else can take over later, because the exchange is two
plain `std_msgs/String` topics carrying JSON.

| Topic | Direction | Payload |
|---|---|---|
| `/iviz/request` | robot to whoever answers | `{"id", "text", "options", ["default"], ["timeout_s"], ["station"], ["source"]}` |
| `/iviz/answer` | answerer back to the robot | `{"id", "answer", ["by"]}` |

The asking side publishes a request and waits for an answer with the same
`id`. The **Dashboard** tab shows every pending request with one button per
option, and also over the map so it is not missed. **Answer by hand** sends
any answer for any id, including one iViz never saw, which is how a robot-side
step is tried out before its real answering node exists. Both topics are
configurable in that tab.

Because nothing in the contract mentions iViz, a node, a PLC adapter or a
button box can answer instead, and the asking side does not change.

On the robot, asking is a dozen lines:

```python
import json, uuid, rclpy
from rclpy.node import Node
from std_msgs.msg import String

class Ask(Node):
    def __init__(self):
        super().__init__("ask_demo")
        self.answers = {}
        self.pub = self.create_publisher(String, "/iviz/request", 10)
        self.create_subscription(String, "/iviz/answer", self.on_answer, 10)

    def ask(self, text, options):
        rid = uuid.uuid4().hex[:8]
        body = {"id": rid, "text": text, "options": options, "source": "ask_demo"}
        self.pub.publish(String(data=json.dumps(body)))
        return rid

    def on_answer(self, msg):
        body = json.loads(msg.data)
        self.answers[body["id"]] = body.get("answer")
```

mission_runner's `ask_user` step is the same idea with a service to answer on
(`/mission/answer`), and the Dashboard drives that too when the runner is
there.

### Topics per station

Mission Builder and mission_runner can give a point its own pair, for example
`/station/conveyor1/request` and `/station/conveyor1/answer`, so a screen or a
node at that station only receives its own questions. iViz handles both ways
of using that:

- **One iViz for every station** (the mock answerer while trying things out):
  leave the Dashboard's topics as they are. The runner announces every
  `ros.request` on `/mission/event` together with the two topics it chose; iViz
  shows the question and answers it on that station's answer topic. The card
  says `answers on /station/conveyor1/answer`, the Topics block lists the
  station pairs picked up so far, and iViz keeps listening on them for the
  session.
- **One iViz at each station**: set that iViz's Dashboard **Requests** and
  **Answers** to the station's pair.

**Answer by hand** has an **Answer topic** field. Left empty, it uses the topic
that came with the request, so answering a station by hand reaches the
station. A node that asks without mission_runner is only heard on the
Dashboard's pair, because there is no event naming its topics.

To try it without a robot:

```bash
npm run mock -- 8765 --ask --auto-answer
```

`--ask` asks a question every 25 seconds, and `--auto-answer` answers requests
that iViz publishes, standing in for a node of yours. `--stations` imitates
mission_runner with two stations asking in turn on their own topics, and logs
any answer sent to the wrong one.

## Typical setups

| Stack | Fixed frame | Layers to enable |
|---|---|---|
| Nav2 + AMCL | `map` | `/map`, `/global_costmap/costmap`, `/local_costmap/costmap`, `/scan`, `/plan`, `/local_plan`, `/amcl_pose`, `/local_costmap/published_footprint` |
| FAST-LIO2 + Livox | `camera_init` | `/cloud_registered` (accumulate: all, color: z), `/Odometry` (trail on), `/path`; optionally `/livox/lidar` |

## Releases and in-app updates

Installed copies of iViz check GitHub Releases for a newer version a few
seconds after launch (and on **About → Check for updates**). When one exists the
user gets an "Install & restart" prompt; the installer is downloaded, its
minisign signature is verified against the public key embedded in the app, and
iViz restarts on the new version.

One-time setup (done for `phuwanat-vg/iviz`, repeat it for a fork):

1. Push the repository to GitHub and point
   `src-tauri/tauri.conf.json` → `plugins.updater.endpoints` at it.
2. The signing keypair was generated at `%USERPROFILE%\.tauri\iviz.key` (private)
   and `iviz.key.pub` (public, already in `tauri.conf.json`). Back the private key
   up somewhere safe. If it is lost, existing installs can never update again.
   Never commit it.
3. In the GitHub repo add two Actions secrets:
   - `TAURI_SIGNING_PRIVATE_KEY` = the full contents of `iviz.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the key password (it was created with an empty password, so set an empty value)

Publishing a release:

```bash
npm run version:set 0.2.0
```

```bash
git commit -am "release v0.2.0" && git tag v0.2.0 && git push && git push --tags
```

The `release` workflow (`.github/workflows/release.yml`) builds the Windows
installer, signs it, creates the GitHub Release with the `.exe`, `.msi`, `.sig`
files and `latest.json`. Running apps pick the new version up automatically.
Add release notes to `CHANGELOG.md` before tagging.

To host updates yourself instead of GitHub, put `latest.json` and the artifacts
on any HTTPS server and list that URL under `plugins.updater.endpoints`. The
format is:

```json
{
  "version": "0.2.0",
  "notes": "What changed",
  "pub_date": "2026-09-02T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<contents of iViz_0.2.0_x64-setup.exe.sig>",
      "url": "https://example.com/iviz/iViz_0.2.0_x64-setup.exe"
    }
  }
}
```

Local signed build (same thing CI does). Use **bash**, not PowerShell:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$USERPROFILE/.tauri/iviz.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
```

PowerShell deletes an environment variable when you assign it an empty string,
so the password never reaches the CLI and the build stops forever on
`Decrypting updater signing key, expect a prompt for password`. A successful
build ends with `Finished 2 updater signatures at:`.

This produces `iViz_<version>_x64-setup.exe` plus a `.sig` file next to it; the
`.sig` contents go into the `signature` field of `latest.json`.

## Project layout

```
src/
  net/FoxgloveConnection.ts   WebSocket client, subscriptions, service calls, CDR decoding, stats
  net/ActionClient.ts         ROS 2 actions over the bridge's hidden services and topics
  ros/                        message schemas (nav2Schemas.ts for actions), types, TF tree, decoder cache
  nav/                        Nav2 tasks with pause and resume (NavController), map export
  viz/Viewer.ts               three.js scene, cameras, controls, pose and editing tools
  viz/layers/                 one renderer per message type, plus RouteLayer and NavOverlayLayer
  ui/App.ts                   top bar, sidebar, layer settings
  ui/NavPanel.ts              Navigation panel on the right and the status bar over the map
  ui/RoutePanel.ts            Route mode sidebar; RouteTools.ts the editing tools
  ui/ActionForm.ts            the action picker and the forms behind it
  mission/                    mission model, validation and the /mission/api client
  state/settings.ts           localStorage persistence
tools/mock-server.ts          fake foxglove_bridge for development
tools/mock-nav2.ts            simulated Nav2 action servers and map saver for the mock
src-tauri/                    Tauri desktop shell
```

## Copyright

© 2026 phuwanat@IRiSH Lab SUT. All rights reserved.

The same notice is shown in the app's **About** box and stamped on the
installer and the executable.
