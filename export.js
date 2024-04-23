const express = require('express');
const morgan = require('morgan');
const winston = require('winston');
const compression = require('compression');
const puppeteer = require('puppeteer');
const zlib = require('zlib');
//const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const crc = require('crc');
const PDFDocument = require('pdf-lib').PDFDocument;
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const childProcess = require('child_process');
let cluster = false;

const NO_CLUSTER = process.env.NO_CLUSTER === '1';

if (!NO_CLUSTER) 
{
	cluster = require('cluster');
	//Force windows to do RR scheduling
	cluster.schedulingPolicy = cluster.SCHED_RR;
}

if (!NO_CLUSTER && cluster.isMaster) 
{
    // Count the machine's CPUs
    let cpuCount = process.env.WORKER_POOL_SIZE || os.cpus().length;

    // Create a worker for each CPU
    for (let i = 0; i < cpuCount; i++) 
	{
        cluster.fork();
    }
	
	// Listen for dying workers
	cluster.on('exit', function (worker) 
	{
		// Replace the dead worker,
		console.log('Worker %d died, restarting...', worker.id);
		cluster.fork();
	});
}
else
{
	const minimal_args = [
		'--disable-gpu',
		'--autoplay-policy=user-gesture-required',
		'--disable-background-networking',
		'--disable-background-timer-throttling',
		'--disable-backgrounding-occluded-windows',
		'--disable-breakpad',
		'--disable-client-side-phishing-detection',
		'--disable-component-update',
		'--disable-default-apps',
		'--disable-dev-shm-usage',
		'--disable-domain-reliability',
		'--disable-extensions',
		'--disable-features=AudioServiceOutOfProcess',
		'--disable-hang-monitor',
		'--disable-ipc-flooding-protection',
		'--disable-notifications',
		'--disable-offer-store-unmasked-wallet-cards',
		'--disable-popup-blocking',
		'--disable-print-preview',
		'--disable-prompt-on-repost',
		'--disable-renderer-backgrounding',
		'--disable-setuid-sandbox',
		'--disable-speech-api',
		'--disable-sync',
		'--hide-scrollbars',
		'--ignore-gpu-blacklist',
		'--metrics-recording-only',
		'--mute-audio',
		'--no-default-browser-check',
		'--no-first-run',
		'--no-pings',
		'--no-sandbox',
		'--no-zygote',
		'--password-store=basic',
		'--use-gl=swiftshader',
		'--use-mock-keychain',
	];

	const MAX_AREA = 20000 * 20000;
	const PNG_CHUNK_IDAT = 1229209940;
	const { JSDOM } = require("jsdom");

	const PORT = process.env.PORT || 8000

	const app = express();

	//Max request size is 10 MB
	app.use(express.urlencoded({ extended: false, limit: '10mb'}));
	app.use(express.json({ limit: '10mb' }));

	app.use(compression({
		threshold: 10,
	}));

	//Enable request logging using morgan and Apache combined format
	app.use(morgan('combined'));

	const logger = winston.createLogger({
	level: 'info',
	format: winston.format.json(),
	transports: [
		//
		// - Write to all logs with level `info` and below to `combined.log` 
		// - Write all logs error (and below) to `error.log`.
		//
		new winston.transports.File({ filename: 'error.log', level: 'error' }),
		new winston.transports.File({ filename: 'combined.log' })
	],
	exceptionHandlers: [
		new winston.transports.File({ filename: 'exceptions.log' })
	]
	});

	//If we're not in production then log to the `console` also
	if (process.env.NODE_ENV !== 'production') 
	{
		logger.add(new winston.transports.Console({
			format: winston.format.simple()
		}));
	}
	
	// NOTE: Key length must not be longer than 79 bytes (not checked)
	function writePngWithText(origBuff, key, text, compressed, base64encoded)
	{
		var isDpi = key == 'dpi';
		var inOffset = 0;
		var outOffset = 0;
		var data = text;
		var dataLen = isDpi? 9 : key.length + data.length + 1; //we add 1 zeros with non-compressed data, for pHYs it's 2 of 4-byte-int + 1 byte
		
		//prepare compressed data to get its size
		if (compressed)
		{
			data = zlib.deflateRawSync(encodeURIComponent(text));
			dataLen = key.length + data.length + 2; //we add 2 zeros with compressed data
		}
		
		var outBuff = Buffer.allocUnsafe(origBuff.length + dataLen + 4); //4 is the header size "zTXt", "tEXt" or "pHYs"
		
		try
		{
			var magic1 = origBuff.readUInt32BE(inOffset);
			inOffset += 4;
			var magic2 = origBuff.readUInt32BE(inOffset);
			inOffset += 4;
			
			if (magic1 != 0x89504e47 && magic2 != 0x0d0a1a0a)
			{
				throw new Error("PNGImageDecoder0");
			}
			
			outBuff.writeUInt32BE(magic1, outOffset);
			outOffset += 4;
			outBuff.writeUInt32BE(magic2, outOffset);
			outOffset += 4;
		}
		catch (e)
		{
			logger.error(e.message, {stack: e.stack});
			throw new Error("PNGImageDecoder1");
		}

		try
		{
			while (inOffset < origBuff.length)
			{
				var length = origBuff.readInt32BE(inOffset);
				inOffset += 4;
				var type = origBuff.readInt32BE(inOffset)
				inOffset += 4;

				if (type == PNG_CHUNK_IDAT)
				{
					// Insert zTXt chunk before IDAT chunk
					outBuff.writeInt32BE(dataLen, outOffset);
					outOffset += 4;
					
					var typeSignature = isDpi? 'pHYs' : (compressed ? "zTXt" : "tEXt");
					outBuff.write(typeSignature, outOffset);
					
					outOffset += 4;

					if (isDpi)
					{
						var dpm = Math.round(parseInt(text) / 0.0254) || 3937; //One inch is equal to exactly 0.0254 meters. 3937 is 100dpi

						outBuff.writeInt32BE(dpm, outOffset);
						outBuff.writeInt32BE(dpm, outOffset + 4);
						outBuff.writeInt8(1, outOffset + 8);
						outOffset += 9;

						data = Buffer.allocUnsafe(9);
						data.writeInt32BE(dpm, 0);
						data.writeInt32BE(dpm, 4);
						data.writeInt8(1, 8);
					}
					else
					{
						outBuff.write(key, outOffset);
						outOffset += key.length;
						outBuff.writeInt8(0, outOffset);
						outOffset ++;

						if (compressed)
						{
							outBuff.writeInt8(0, outOffset);
							outOffset ++;
							data.copy(outBuff, outOffset);
						}
						else
						{
							outBuff.write(data, outOffset);	
						}

						outOffset += data.length;				
					}

					var crcVal = 0xffffffff;
					crcVal = crc.crcjam(typeSignature, crcVal);
					crcVal = crc.crcjam(data, crcVal);

					// CRC
					outBuff.writeInt32BE(crcVal ^ 0xffffffff, outOffset);
					outOffset += 4;

					// Writes the IDAT chunk after the zTXt
					outBuff.writeInt32BE(length, outOffset);
					outOffset += 4;
					outBuff.writeInt32BE(type, outOffset);
					outOffset += 4;

					origBuff.copy(outBuff, outOffset, inOffset);

					// Encodes the buffer using base64 if requested
					return base64encoded? outBuff.toString('base64') : outBuff;
				}

				outBuff.writeInt32BE(length, outOffset);
				outOffset += 4;
				outBuff.writeInt32BE(type, outOffset);
				outOffset += 4;

				origBuff.copy(outBuff, outOffset, inOffset, inOffset + length + 4);// +4 to move past the crc
				
				inOffset += length + 4;
				outOffset += length + 4;
			}
		}
		catch (e)
		{
			logger.error(e.message, {stack: e.stack});
			throw e;
		}
	}

	//From https://advancedweb.hu/secure-tempfiles-in-nodejs-without-dependencies/
	const withTempFile = (fn) => withTempDir((dir) => fn(path.join(dir, "file")));

	const withTempDir = async (fn) => {
		const dir = await fs.mkdtemp(await fs.realpath(os.tmpdir()) + path.sep);
		try {
			return await fn(dir);
		} finally {
			//fs.rm is not available on old node versions
			(fs.rm || fs.rmdir)(dir, {recursive: true});
		}
	};

	function execFile(binPath, args)
	{
		return new Promise(function (resolve, reject) 
		{
			childProcess.execFile(binPath, args, {
				timeout: 25000 //25 sec
			}, (error, stdout, stderr) =>
			{
				if (error) 
				{
					reject(error);
				}
				else
				{
					resolve(stdout);
				}
			});
		});
	};

	async function mergePdfs(pdfFiles, xml)
	{
		//Pass throgh single files
		if (pdfFiles.length == 1 && xml == null)
		{
			return pdfFiles[0];
		}

		try 
		{
			const pdfDoc = await PDFDocument.create();
			pdfDoc.setCreator('draw.io');

			if (xml != null)
			{	
				//Embed diagram XML as file attachment
				await pdfDoc.attach(Buffer.from(xml).toString('base64'), 'diagram.xml', {
					mimeType: 'application/vnd.jgraph.mxfile',
					description: 'Diagram Content'
				});
			}

			for (var i = 0; i < pdfFiles.length; i++)
			{
				const pdfFile = await PDFDocument.load(pdfFiles[i].buffer);
				const pages = await pdfDoc.copyPages(pdfFile, pdfFile.getPageIndices());
				pages.forEach(p => pdfDoc.addPage(p));
			}

			const pdfBytes = await pdfDoc.save();
			return Buffer.from(pdfBytes);
		}
		catch(e)
		{
			//Sometimes embedding xml cause errors, so try again without embedding
			if (xml != null)
			{
				return mergePdfs(pdfFiles, null);
			}

			let errMsg = 'Error during PDF combination: ' + e.message;
			logger.error(errMsg);
			throw new Error(errMsg);
		}
	}

	app.post('*', handleRequest);
	app.get('*', handleRequest);

	async function handleRequest(req, res) 
	{
		try
		{
			//Merge all parameters into body such that get and post works the same	
			Object.assign(req.body, req.params, req.query);
			
			// Checks for HTML export request
			// Removed until we secure it
			/*if (req.body.html)
			{
				var html = req.body.html;

				logger.info("HTML export referer: " + req.get("referer"));

				var wp = req.body.w;
				var w = (wp == null) ? 0 : parseInt(wp);

				var hp = req.body.h;
				var h = (hp == null) ? 0 : parseInt(hp);
				var browser = null;

				try
				{
					html = decodeURIComponent(
						zlib.inflateRawSync(
								Buffer.from(decodeURIComponent(html), 'base64')).toString());
					
					browser = await puppeteer.launch({
						headless: 'chrome-headless-shell',
						args: minimal_args,
						userDataDir: './puppeteer_user_data' + cluster.worker.id
					});
					
					// Workaround for timeouts/zombies is to kill after 30 secs
					setTimeout(function()
					{
						browser.close();
					}, 30000);
					
					const page = await browser.newPage();
					await page.setContent(html, {waitUntil: "networkidle0"});

					page.setViewport({width: w, height: h});

					var data = await page.screenshot({
					type: 'png'
					});

					// Cross-origin access should be allowed to now
					res.header("Access-Control-Allow-Origin", "*");
					res.header('Content-disposition', 'attachment; filename="capture.png"');
					res.header('Content-type', 'image/png');
					
					res.end(data);

					browser.close();
				}
				catch (e)
				{
					if (browser != null)
					{
						browser.close();
					}
					
					logger.info("Inflate failed for HTML input: " + html);
					throw e;
				}
			}
			else*/
			{	
				var xml;

				// Removed until we secure it. Remember to add back the fetch import
				/*if (req.body.url)
				{
					var urlRes = await fetch(req.body.url);
					xml = await urlRes.text();
					
					if (req.body.format == null)
						req.body.format = 'png';
				}
				else*/ if (req.body.xmldata)
				{
					try
					{
						xml = zlib.inflateRawSync(
								Buffer.from(decodeURIComponent(req.body.xmldata), 'base64')).toString();
					}
					catch (e)
					{
						logger.info("Inflate failed for XML input: " + req.body.xmldata);
						throw e;
					}
				}
				else
				{
					xml = req.body.xml;
				}
				
				if (xml != null && xml.indexOf("%3C") == 0)
				{
					xml = decodeURIComponent(xml);
				}
				
				// Extracts the compressed XML from the DIV in a HTML document
				if (xml != null && (xml.indexOf("<!DOCTYPE html>") == 0
						|| xml.indexOf("<!--[if IE]><meta http-equiv") == 0)) //TODO not tested!
				{
					try
					{
						var doc = new JSDOM(xml).window.document;
						var divs = doc.documentElement
								.getElementsByTagName("div");

						if (divs != null && divs.length > 0
								&& "mxgraph" == (divs.item(0).attributes
										.getNamedItem("class").nodeValue))
						{
							if (divs.item(0).nodeType == 1)
							{
								if (divs.item(0).hasAttribute("data-mxgraph"))
								{
									var jsonString = divs.item(0).getAttribute("data-mxgraph");

									if (jsonString != null)
									{
										var obj = JSON.parse(jsonString);
										xml = obj["xml"];
									}
								}
								else
								{
									divs = divs.item(0).getElementsByTagName("div");

									if (divs != null && divs.length > 0)
									{
										var tmp = divs.item(0).textContent;

										if (tmp != null)
										{
											tmp = zlib.inflateRawSync(Buffer.from(tmp, 'base64')).toString();
											
											if (tmp != null && tmp.length > 0)
											{
												xml = decodeURIComponent(tmp);
											}
										}
									}
								}
							}
						}
					}
					catch (e)
					{
						// ignore
					}
				}
				
				// Extracts the URL encoded XML from the content attribute of an SVG node
				if (xml != null && (xml.indexOf(
						"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">") == 0))
				{//TODO not tested!
					try
					{
						var doc = new JSDOM(xml).window.document;

						if (doc != null && doc.documentElement != null && doc
								.documentElement.nodeName == "svg")
						{
							var content = doc.documentElement.getAttribute("content");
							
							if (content != null)
							{
								xml = content;
								
								if (xml.charAt(0) == '%')
								{
									xml = decodeURIComponent(xml);
								}
							}
						}
					}
					catch (e)
					{
						// ignore
					}
				}
				
				req.body.w = req.body.w || 0;
				req.body.h = req.body.h || 0;

				// Checks parameters
				if (req.body.format && xml && req.body.w * req.body.h <= MAX_AREA)
				{
					var browser = null;
					
					try
					{
						var reqStr = ((xml != null) ? "xml=" + xml.length : "")
							+ ((req.body.embedXml != null) ? " embed=" + req.body.embedXml : "") + " format="
							+ req.body.format;
							
						req.body.xml = xml;

						var t0 = Date.now();
						
						browser = await puppeteer.launch({
							headless: 'chrome-headless-shell',
							args: minimal_args,
							userDataDir: './puppeteer_user_data' + cluster.worker.id
						});

						// Workaround for timeouts/zombies is to kill after 30 secs
						setTimeout(function()
						{
							browser.close();
						}, 30000);
						
						const page = await browser.newPage();

						async function renderPage()
						{
							// LATER: Reuse same page (ie. reuse image- and font cache, reset state, viewport and remove LoadingComplete on each iteration)
							// Moving to DRAWIO_BASE_URL but keeping DRAWIO_SERVER_URL for backward compatibility
							await page.goto((process.env.DRAWIO_BASE_URL || process.env.DRAWIO_SERVER_URL || 'https://viewer.diagrams.net') + '/export3.html', {waitUntil: 'networkidle0'});
							
							var arg = {
								xml: req.body.xml,
								format: req.body.format,
								w: req.body.w,
								h: req.body.h,
								crop: req.body.crop,
								border: req.body.border,
								bg: req.body.bg,
								allPages: req.body.allPages,
								from: req.body.from,
								to: req.body.to,
								pageId: req.body.pageId,
								scale: req.body.scale || 1,
								extras: req.body.extras,
								pageMargin: req.body.pageMargin
							};
							
							await page.evaluate((arg) => {
								return render(arg);
							}, arg);

							//default timeout is 30000 (30 sec)
							await page.waitForSelector('#LoadingComplete');

							var bounds = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('bounds'));
							var pageId = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('page-id'))
							var pageId = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('page-id'));
							var scale  = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('scale'));
							var pageCount  = parseInt(await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('pageCount')));

							if (req.body.format != 'pdf')
							{
								if (bounds != null)
								{
									bounds = JSON.parse(bounds);
									var isPdf = req.body.format == 'pdf';

									//Chrome generates Pdf files larger than requested pixels size and requires scaling
									//For images, the fixing scale shows scrollbars
									var fixingScale = isPdf? 0.959 : 1;
	
									var w = Math.ceil(Math.ceil(bounds.width + bounds.x) * fixingScale);
									
									// +0.1 fixes cases where adding 1px below is not enough
									// Increase this if more cropped PDFs have extra empty pages
									var h = Math.ceil(Math.ceil(bounds.height + bounds.y) * fixingScale + (isPdf? 0.1 : 0));
									
									var w = Math.ceil(bounds.width + bounds.x);
									var h = Math.ceil(bounds.height + bounds.y);
									page.setViewport({width: w, height: h});
								}
							}

							var pdfOptions = {
								preferCSSPageSize: true,
								printBackground: true,
								omitBackground: true
							};
							
							return {pdfOptions: pdfOptions, pageId: pageId, scale: scale, pageCount: pageCount, w: w, h: h};
						}

						// Cross-origin access should be allowed to now
						res.header("Access-Control-Allow-Origin", "*");
						
						var base64encoded = req.body.base64 == "1";
						
						if (req.body.format == 'png' || req.body.format == 'jpg' || req.body.format == 'jpeg')
						{
							var info = await renderPage(req.body.from || 0);
							var pageId = info.pageId, scale = info.scale, h = info.h, w = info.w;

							var data = await page.screenshot({
								omitBackground: req.body.format == 'png' && (req.body.bg == null || req.body.bg == 'none'),	
								type: req.body.format == 'jpg' ? 'jpeg' : req.body.format,
								fullPage: true
							});

							if (req.body.dpi != null && req.body.format == 'png')
							{
								data = writePngWithText(data, 'dpi', req.body.dpi);
							}
							
							if (req.body.embedXml == "1" && req.body.format == 'png')
							{
								data = writePngWithText(data, "mxGraphModel",
									xml, true, base64encoded);
							}
							else if (req.body.embedData == "1" && req.body.format == 'png')
							{
								data = writePngWithText(data, req.body.dataHeader,
									req.body.data, true, base64encoded);
							}
							else
							{
								if (base64encoded)
								{
									data = data.toString('base64');
								}

								if (data.length == 0)
								{
									throw new Error("Invalid image");
								}
							}

							if (req.body.filename != null && req.body.filename != '')
							{
								logger.info("Filename in request " + req.body.filename);

								res.header('Content-disposition', 'attachment; filename="' + req.body.filename +
									'"; filename*=UTF-8\'\'' + req.body.filename);
							}
							
							res.header('Content-type', base64encoded? 'text/plain' : ('image/' + req.body.format));
							res.header("Content-Length", data.length);
							
							// These two parameters are for Google Docs or other recipients to transfer the real image width x height information
							// (in case this information is inaccessible or lost)
							res.header("content-ex-width", w);
							res.header("content-ex-height", h);
							
							if (pageId != null && pageId != 'undefined')
							{
								res.header("content-page-id", pageId);
							}

							if (scale != null && scale != 'undefined')
							{
								res.header("content-scale", scale);
							}

							res.end(data);

							var dt = Date.now() - t0;
							
							logger.info("Success " + reqStr + " dt=" + dt);
						}
						else if (req.body.format == 'pdf')
						{
							var pageId;
							var info = await renderPage()
							var data = await page.pdf(info.pdfOptions);

							// Converts to PDF 1.7 with compression
							const pdfDoc = await PDFDocument.load(data);
							
							if (req.body.embedXml == "1")
							{
								// KNOWN: Attachments produce smaller files but break
								// internal links in pdf-lib so using Subject for now
								// https://github.com/Hopding/pdf-lib/issues/341
								// await pdfDoc.attach(Buffer.from(xml).toString('base64'), 'diagram.xml', {
								// 	mimeType: 'application/vnd.jgraph.mxfile',
								// 	description: 'Diagram Content'
								// });
								pdfDoc.setSubject(encodeURIComponent(xml).
									replace(/\(/g, "\\(").replace(/\)/g, "\\)"));
							}

							const pdfBytes = await pdfDoc.save();
							data = Buffer.from(pdfBytes);

							if (req.body.filename != null && req.body.filename != '')
							{
								res.header('Content-disposition', 'attachment; filename="' + req.body.filename +
										'"; filename*=UTF-8\'\'' + req.body.filename);
							}
							
							if (base64encoded)
							{
								data = data.toString('base64');
							}
							
							res.header('Content-type', base64encoded? 'text/plain' : 'application/pdf');
							res.header("Content-Length", data.length);
							
							if (pageId != null && pageId != 'undefined')
							{
								res.header("content-page-id", pageId);
							}

							res.end(data);

							var dt = Date.now() - t0;
							
							logger.info("Success " + reqStr + " dt=" + dt);
						}
						else 
						{
							//BAD_REQUEST
							res.status(400).end("Unsupported Format!");
							logger.warn("Unsupported Format: " + req.body.format);
						}
						await browser.close();
					}
					catch (e)
					{
						if (browser != null)
						{
							browser.close();
						}
						
						res.status(500).end("Error!");
						
						var ip = (req.headers['x-forwarded-for'] ||
									req.connection.remoteAddress ||
									req.socket.remoteAddress ||
									req.connection.socket.remoteAddress).split(",")[0];
						
						var reqStr = "ip=" + ip + " ";

						if (req.body.format != null)
						{
							reqStr += ("format=" + req.body.format + " ");
						}

						if (req.body.w != null)
						{
							reqStr += ("w=" + req.body.w + " ");
						}

						if (req.body.h != null)
						{
							reqStr += ("h=" + req.body.h + " ");
						}

						if (req.body.scale != null)
						{
							reqStr += ("s=" + req.body.scale + " ");
						}

						if (req.body.bg != null)
						{
							reqStr += ("bg=" + req.body.bg + " ");
						}

						if (req.body.xmlData != null)
						{
							reqStr += ("xmlData=" + req.body.xmlData.length + " ");
						}

						logger.warn("Handled exception: " + e.message
								+ " req=" + reqStr, {stack: e.stack});
						
					}
				}
				else
				{
					res.status(400).end("BAD REQUEST");
				}
			}
		}
		catch(e)
		{
			logger.error(e.message, {stack: e.stack});
			//INTERNAL_SERVER_ERROR
			res.status(500).end("Unknown error");
		}
	};

	app.listen(PORT, function () 
	{
		if (NO_CLUSTER)
		{
			console.log(`draw.io export server listening on port ${PORT}...`);
		}
		else
		{
			console.log(`draw.io export server worker ${cluster.worker.id} listening on port ${PORT}...`);
		}
	});
}