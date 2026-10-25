//! Print an HTML page to a PDF file with the system's own web view: WKWebView on
//! macOS, WebView2 on Windows, WebKitGTK on Linux. Used to turn Markdown into PDF.
//!
//! The page is served from a private `unacroprint:` address to a hidden window,
//! with a Content-Security-Policy that allows no scripts and no network access
//! except images (web images only appear in the page if the user chose to load
//! them). When the page has finished loading (images included), it is printed
//! to a temporary PDF without any dialog, and the bytes are returned.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::http;
use tauri::ipc::Response;
use tauri::webview::{PageLoadEvent, PlatformWebview};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, WebviewUrl, WebviewWindowBuilder};

pub const SCHEME: &str = "unacroprint";

/// How long a conversion may take, including loading web images.
const TIMEOUT: Duration = Duration::from_secs(90);

/// Pages waiting to be served to their print window, by job id.
#[derive(Default)]
pub struct PrintJobs(Mutex<HashMap<u64, String>>);

static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Paper {
    A4,
    Letter,
}

impl Paper {
    fn parse(s: &str) -> Paper {
        if s.eq_ignore_ascii_case("letter") { Paper::Letter } else { Paper::A4 }
    }
    /// Width and height in points.
    #[allow(dead_code)]
    fn points(self) -> (f64, f64) {
        match self {
            Paper::A4 => (595.28, 841.89),
            Paper::Letter => (612.0, 792.0),
        }
    }
}

/// Page margin on every side, in points (¾ inch, about 19 mm).
#[allow(dead_code)]
const MARGIN_PT: f64 = 54.0;

type Done = Sender<Result<(), String>>;

/// Serves `unacroprint://localhost/<job>` to the print windows.
pub fn serve<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    let id: Option<u64> = request.uri().path().trim_matches('/').parse().ok();
    let html = id.and_then(|id| ctx.app_handle().state::<PrintJobs>().0.lock().unwrap().get(&id).cloned());
    match html {
        Some(html) => http::Response::builder()
            .header("Content-Type", "text/html; charset=utf-8")
            .header(
                "Content-Security-Policy",
                "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:",
            )
            .body(html.into_bytes())
            .unwrap(),
        None => http::Response::builder().status(404).body(Vec::new()).unwrap(),
    }
}

fn job_url(id: u64) -> tauri::Url {
    // WebView2 (and Android) reach custom protocols through http://<scheme>.localhost.
    let s = if cfg!(any(windows, target_os = "android")) {
        format!("http://{SCHEME}.localhost/{id}")
    } else {
        format!("{SCHEME}://localhost/{id}")
    };
    tauri::Url::parse(&s).expect("valid print url")
}

/// Print an HTML page to PDF and return the PDF's bytes.
#[tauri::command]
pub async fn html_to_pdf<R: Runtime>(app: AppHandle<R>, html: String, paper: String) -> Result<Response, String> {
    let id = NEXT_JOB.fetch_add(1, Ordering::Relaxed);
    let paper = Paper::parse(&paper);
    let out = std::env::temp_dir().join(format!("unacro-print-{}-{id}.pdf", std::process::id()));
    app.state::<PrintJobs>().0.lock().unwrap().insert(id, html);

    let (tx, rx) = channel::<Result<(), String>>();
    let started = Arc::new(AtomicBool::new(false));
    let on_load_tx = tx.clone();
    let on_load_out = out.clone();
    let built = WebviewWindowBuilder::new(&app, format!("print-{id}"), WebviewUrl::CustomProtocol(job_url(id)))
        .title("Unacro print")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(816.0, 1056.0)
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished || started.swap(true, Ordering::SeqCst) {
                return;
            }
            let tx = on_load_tx.clone();
            let out = on_load_out.clone();
            let fail = tx.clone();
            if let Err(e) = window.with_webview(move |pv| platform::print(pv, &out, paper, tx)) {
                let _ = fail.send(Err(e.to_string()));
            }
        })
        .build();
    drop(tx);

    let window = match built {
        Ok(w) => w,
        Err(e) => {
            app.state::<PrintJobs>().0.lock().unwrap().remove(&id);
            return Err(format!("Couldn't open the print view: {e}"));
        }
    };

    let waited = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(TIMEOUT)).await;
    app.state::<PrintJobs>().0.lock().unwrap().remove(&id);
    let _ = window.destroy();

    let result = match waited {
        Ok(Ok(Ok(()))) => read_pdf(&out),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(std::sync::mpsc::RecvTimeoutError::Timeout)) => Err("Making the PDF took too long.".into()),
        Ok(Err(_)) => Err("The print view closed before the PDF was made.".into()),
        Err(e) => Err(e.to_string()),
    };
    let _ = std::fs::remove_file(&out);
    result.map(Response::new)
}

fn read_pdf(path: &PathBuf) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("The PDF wasn't written: {e}"))?;
    if !bytes.starts_with(b"%PDF") {
        return Err("The system didn't produce a PDF.".into());
    }
    Ok(bytes)
}

// ------------------------------------------------------------------ Linux

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::cell::RefCell;
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    thread_local! {
        /// Operations in progress, kept alive until they finish.
        static ACTIVE: RefCell<Vec<PrintOperation>> = const { RefCell::new(Vec::new()) };
    }

    pub fn print(pv: PlatformWebview, out: &Path, paper: Paper, done: Done) {
        let uri = match gtk::glib::filename_to_uri(out, None) {
            Ok(u) => u,
            Err(e) => {
                let _ = done.send(Err(e.to_string()));
                return;
            }
        };
        let paper_size = gtk::PaperSize::new(Some(match paper {
            Paper::A4 => "iso_a4",
            Paper::Letter => "na_letter",
        }));
        let settings = gtk::PrintSettings::new();
        settings.set_printer("Print to File");
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(uri.as_str()));
        settings.set_paper_size(&paper_size);
        settings.set_orientation(gtk::PageOrientation::Portrait);

        let setup = gtk::PageSetup::new();
        setup.set_paper_size(&paper_size);
        setup.set_orientation(gtk::PageOrientation::Portrait);
        setup.set_top_margin(MARGIN_PT, gtk::Unit::Points);
        setup.set_bottom_margin(MARGIN_PT, gtk::Unit::Points);
        setup.set_left_margin(MARGIN_PT, gtk::Unit::Points);
        setup.set_right_margin(MARGIN_PT, gtk::Unit::Points);

        let op = PrintOperation::new(&pv.inner());
        op.set_print_settings(&settings);
        op.set_page_setup(&setup);
        let failed = done.clone();
        op.connect_failed(move |_, e| {
            let _ = failed.send(Err(e.to_string()));
        });
        op.connect_finished(move |op| {
            // After "failed" this just sends a second message nobody reads.
            let _ = done.send(Ok(()));
            ACTIVE.with(|a| a.borrow_mut().retain(|o| o != op));
        });
        ACTIVE.with(|a| a.borrow_mut().push(op.clone()));
        op.print();
    }
}

// ------------------------------------------------------------------ Windows

#[cfg(windows)]
mod platform {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    pub fn print(pv: PlatformWebview, out: &Path, paper: Paper, done: Done) {
        let (w, h) = paper.points();
        let inch = |pt: f64| pt / 72.0;
        let finished = done.clone();
        let result = (|| -> windows_core::Result<()> {
            unsafe {
                let core = pv.controller().CoreWebView2()?;
                let webview: ICoreWebView2_7 = core.cast()?;
                let env: ICoreWebView2Environment6 = pv.environment().cast()?;
                let settings = env.CreatePrintSettings()?;
                settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
                settings.SetPageWidth(inch(w))?;
                settings.SetPageHeight(inch(h))?;
                settings.SetMarginTop(inch(MARGIN_PT))?;
                settings.SetMarginBottom(inch(MARGIN_PT))?;
                settings.SetMarginLeft(inch(MARGIN_PT))?;
                settings.SetMarginRight(inch(MARGIN_PT))?;
                settings.SetScaleFactor(1.0)?;
                settings.SetShouldPrintBackgrounds(true)?;
                settings.SetShouldPrintHeaderAndFooter(false)?;
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                    let _ = finished.send(match result {
                        Err(e) => Err(e.to_string()),
                        Ok(()) if ok => Ok(()),
                        Ok(()) => Err("WebView2 couldn't print the page.".into()),
                    });
                    Ok(())
                }));
                webview.PrintToPdf(&HSTRING::from(out.as_os_str()), &settings, &handler)?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            let _ = done.send(Err(e.to_string()));
        }
    }
}

// ------------------------------------------------------------------ macOS

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::cell::RefCell;
    use std::ffi::c_void;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol};
    use objc2::{define_class, msg_send, sel, AllocAnyThread, DefinedClass};
    use objc2_app_kit::{
        NSPrintHeaderAndFooter, NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob,
        NSPrintingPaginationMode,
    };
    use objc2_foundation::{NSCopying, NSNumber, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;

    pub struct DelegateIvars {
        done: Mutex<Option<Done>>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and the class has no Drop.
        #[unsafe(super(NSObject))]
        #[name = "UnacroPrintDelegate"]
        #[ivars = DelegateIvars]
        pub struct PrintDelegate;

        impl PrintDelegate {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, _op: &NSPrintOperation, success: Bool, _context: *mut c_void) {
                if let Some(done) = self.ivars().done.lock().unwrap().take() {
                    let _ = done.send(if success.as_bool() { Ok(()) } else { Err("macOS couldn't print the page.".into()) });
                }
            }
        }
    );

    impl PrintDelegate {
        fn new(done: Done) -> Retained<Self> {
            let this = Self::alloc().set_ivars(DelegateIvars { done: Mutex::new(Some(done)) });
            unsafe { msg_send![super(this), init] }
        }
    }

    thread_local! {
        /// The delegate of a running print operation must outlive it; kept here until the next print.
        static DELEGATES: RefCell<Vec<Retained<PrintDelegate>>> = const { RefCell::new(Vec::new()) };
    }

    pub fn print(pv: PlatformWebview, out: &Path, paper: Paper, done: Done) {
        unsafe {
            let webview: &WKWebView = &*(pv.inner() as *const WKWebView);
            let Some(window) = webview.window() else {
                let _ = done.send(Err("The print view has no window.".into()));
                return;
            };
            if !webview.respondsToSelector(sel!(printOperationWithPrintInfo:)) {
                let _ = done.send(Err("Making PDFs from Markdown needs macOS 11 or later.".into()));
                return;
            }

            let (w, h) = paper.points();
            let info: Retained<NSPrintInfo> = NSPrintInfo::sharedPrintInfo().copy();
            info.setPaperSize(NSSize::new(w, h));
            info.setTopMargin(MARGIN_PT);
            info.setBottomMargin(MARGIN_PT);
            info.setLeftMargin(MARGIN_PT);
            info.setRightMargin(MARGIN_PT);
            info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
            info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
            info.setHorizontallyCentered(false);
            info.setVerticallyCentered(false);
            info.setJobDisposition(NSPrintSaveJob);
            let url = NSURL::fileURLWithPath(&NSString::from_str(&out.to_string_lossy()));
            let dict = info.dictionary();
            let url_obj: &AnyObject = &url;
            dict.insert(NSPrintJobSavingURL, url_obj);
            let no = NSNumber::new_bool(false);
            let no_obj: &AnyObject = &no;
            dict.insert(NSPrintHeaderAndFooter, no_obj);

            let op = webview.printOperationWithPrintInfo(&info);
            op.setShowsPrintPanel(false);
            op.setShowsProgressPanel(false);
            // Without a frame, WKWebView's print view produces blank pages.
            if let Some(view) = op.view() {
                view.setFrame(webview.frame());
            }

            let delegate = PrintDelegate::new(done);
            DELEGATES.with(|d| {
                let mut d = d.borrow_mut();
                d.retain(|x| x.ivars().done.lock().unwrap().is_some());
                d.push(delegate.clone());
            });
            let delegate_obj: &AnyObject = &delegate;
            op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                Some(delegate_obj),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
    }
}

// Other platforms (mobile) can't do this.
#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
mod platform {
    use super::*;
    pub fn print(_pv: PlatformWebview, _out: &Path, _paper: Paper, done: Done) {
        let _ = done.send(Err("Making PDFs isn't supported on this system.".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paper_names() {
        assert_eq!(Paper::parse("letter"), Paper::Letter);
        assert_eq!(Paper::parse("Letter"), Paper::Letter);
        assert_eq!(Paper::parse("a4"), Paper::A4);
        assert_eq!(Paper::parse("anything"), Paper::A4);
    }

    #[test]
    fn job_urls_use_the_print_scheme() {
        let u = job_url(7).to_string();
        assert!(u.ends_with("/7"));
        assert!(u.contains(SCHEME));
    }
}
