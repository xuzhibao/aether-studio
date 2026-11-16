use serde::Serialize;
use serialport::SerialPort;
use std::{
    io::{Read, Write},
    sync::Mutex,
    time::Duration,
};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime, State,
};

#[derive(Default)]
pub struct SerialState(Mutex<Session>);
#[derive(Default)]
struct Session {
    next_id: u32,
    active: Option<(u32, Box<dyn SerialPort>)>,
}
#[derive(Serialize)]
struct PortInfo {
    path: String,
    label: String,
}

impl SerialState {
    fn open(&self, path: &str, baud_rate: u32) -> Result<u32, String> {
        if path.is_empty() || baud_rate == 0 {
            return Err("串口路径和波特率无效".into());
        }
        let mut session = self.0.lock().unwrap();
        if session.active.is_some() {
            return Err("已有打开的串口，请先断开".into());
        }
        let port = serialport::new(path, baud_rate)
            .timeout(Duration::from_millis(50))
            .open()
            .map_err(|e| e.to_string())?;
        session.next_id += 1;
        let id = session.next_id;
        session.active = Some((id, port));
        Ok(id)
    }
    fn with_port<T>(
        &self,
        id: u32,
        f: impl FnOnce(&mut dyn SerialPort) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut session = self.0.lock().unwrap();
        match session.active.as_mut() {
            Some((active_id, port)) if *active_id == id => f(port.as_mut()),
            _ => Err("串口连接已关闭".into()),
        }
    }
    fn read(&self, id: u32) -> Result<Vec<u8>, String> {
        self.with_port(id, |port| {
            let available = port.bytes_to_read().map_err(|e| e.to_string())? as usize;
            if available == 0 {
                return Ok(Vec::new());
            }
            let mut bytes = vec![0; available.min(4096)];
            let size = port.read(&mut bytes).map_err(|e| e.to_string())?;
            bytes.truncate(size);
            Ok(bytes)
        })
    }
    fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        self.with_port(id, |port| port.write_all(data).map_err(|e| e.to_string()))
    }
    fn close(&self, id: u32) {
        let mut session = self.0.lock().unwrap();
        if session
            .active
            .as_ref()
            .is_some_and(|(active_id, _)| *active_id == id)
        {
            session.active = None;
        }
    }
}
#[tauri::command]
async fn list() -> Result<Vec<PortInfo>, String> {
    serialport::available_ports()
        .map(|ports| {
            ports
                .into_iter()
                .map(|port| {
                    let label = match port.port_type {
                        serialport::SerialPortType::UsbPort(info) => {
                            info.product.unwrap_or_else(|| "USB Serial".into())
                        }
                        _ => "Serial port".into(),
                    };
                    PortInfo {
                        path: port.port_name,
                        label,
                    }
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn open(state: State<'_, SerialState>, path: String, baud_rate: u32) -> Result<u32, String> {
    state.open(&path, baud_rate)
}
#[tauri::command]
async fn read(state: State<'_, SerialState>, id: u32) -> Result<Vec<u8>, String> {
    state.read(id)
}
#[tauri::command]
async fn write(state: State<'_, SerialState>, id: u32, data: Vec<u8>) -> Result<(), String> {
    state.write(id, &data)
}
#[tauri::command]
async fn close(state: State<'_, SerialState>, id: u32) -> Result<(), String> {
    state.close(id);
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("serial")
        .setup(|app, _| {
            app.manage(SerialState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list, open, read, write, close])
        .build()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn serial_round_trip_and_stale_session() {
        let (mut peer, slave) = serialport::TTYPort::pair().unwrap();
        let path = slave.name().unwrap();
        drop(slave);
        peer.set_timeout(Duration::from_secs(2)).unwrap();
        let state = SerialState::default();
        assert!(state.open("/nonexistent/aether-serial", 115200).is_err());
        let id = state.open(&path, 115200).unwrap();
        assert!(state.open(&path, 115200).is_err());
        peer.write_all("温度:24.6\n".as_bytes()).unwrap();
        let mut received = Vec::new();
        for _ in 0..100 {
            received.extend(state.read(id).unwrap());
            if received.ends_with(b"\n") {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(String::from_utf8(received).unwrap(), "温度:24.6\n");
        state.write(id, b"status\r\n").unwrap();
        let mut sent = [0; 8];
        peer.read_exact(&mut sent).unwrap();
        assert_eq!(&sent, b"status\r\n");
        state.close(id);
        assert!(state.write(id, b"closed").is_err());
        let next = state.open(&path, 115200).unwrap();
        state.close(id);
        assert!(
            state.read(next).is_ok(),
            "stale close must not close a new connection"
        );
        state.close(next);
    }
}
