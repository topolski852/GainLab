<div align="center">
  <img src="assets/banner.svg" alt="GainLab" width="100%"/>
</div>

<br/>

**GainLab** is an open-source desktop app for FRC teams to tune PID and feedforward gains for robot mechanisms. Instead of guessing gains and re-deploying, GainLab uses a Bayesian optimizer to systematically explore the gain space, run step-response tests, and converge on high-performing values — in simulation or on a live robot.

Built by [Team 1507 – Warlocks](https://warlocks1507.com).

---

## Features

- **Bayesian auto-tune** — Gaussian Process optimizer with Expected Improvement suggests the next gain set to test after each experiment, converging significantly faster than manual iteration
- **Physics simulation** — DC motor model (back-EMF, current limiting, torque) integrated at 5 ms; no robot required to start tuning
- **Live robot mode** — connects via NT4 WebSocket to a running robot, sends setpoints, reads actuals, and scores real response data
- **Multi-phase tuning** — progressively tightens the search radius across phases (rough exploration → fine-tune → stress test), with each phase running a harder test sequence than the last
- **Mechanism support** — velocity (flywheel/roller), position (arm/elevator), and Motion Magic control modes
- **Export ready** — one-click export of tuned gains as a Phoenix 6 `TalonFXConfiguration` Java snippet, ready to paste into `Constants.java`
- **Step response graphs** — live-updating charts showing setpoint vs. actual with overshoot, settling time, and SSE score

## Requirements

- Node.js 20+
- A CTRE Phoenix 6 compatible robot or use simulation mode (no robot needed)

## Getting Started

```bash
git clone https://github.com/warlocks1507/gainlab.git
cd gainlab
npm install
npm run dev
```

## Tuning Workflow

1. **New Project** — create a project file (saved as `.gainlab.json`)
2. **Add a Motor** — configure mechanism type, control mode, motor specs, and operating range
3. **Run Auto-Tune** — the Bayesian optimizer runs multi-phase experiments and converges on optimal gains
4. **Review Results** — inspect step response graphs, phase history, and final gain values
5. **Export** — copy the generated Java snippet into your robot project

## Tech Stack

| Layer | Technology |
|---|---|
| App framework | Electron + electron-vite |
| UI | React + TypeScript |
| Graphing | Recharts |
| Robot comms | NT4 WebSocket + MessagePack |
| Optimizer | Custom Gaussian Process (no external ML deps) |

## License

MIT — free to use, fork, and build on.
