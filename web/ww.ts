/// <reference lib="es2018" />
/// <reference lib="dom" />

// Declare WASM symbols.
declare var webwormhole: {
	decode(code: string): [number, Uint8Array];
	encode(slot: number, pass: Uint8Array): string;
	start(pass: Uint8Array): string;
	exchange(pass: Uint8Array, msg: string): [Uint8Array, string];
	finish(msg: Uint8Array): Uint8Array;
	open(key: Uint8Array, msg: string): string;
	seal(key: Uint8Array, msg: string): string;
	fingerprint(key: Uint8Array): Uint8Array;
}

// Declare Go WASM loader symbols.
declare class Go {
	importObject: WebAssembly.Imports;
	run(instance: WebAssembly.Instance): void;
}

// The ICEServers JSON as exported from Pion capitalises field names, but
// JS expects lowercase dictionary entries.
type GoICEServers = [{ URLs:[string], Username: string, Credential: string }];

// Error codes from webwormhole/dial.go.
enum WormholeErrorCodes {
	closeNoSuchSlot = 4000,
	closeSlotTimedOut = 4001,
	closeNoMoreSlots = 4002,
	closeWrongProto = 4003,
	closePeerHungUp = 4004,
	closeBadKey = 4005,
	closeWebRTCSuccess = 4006,
	closeWebRTCSuccessDirect = 4007,
	closeWebRTCSuccessRelay = 4008,
	closeWebRTCFailed = 4009,
}

class Wormhole {
	// Signalling protocol version.
	static readonly protocol = "4";

	pass: Uint8Array;
	state: string; // TODO enum?
	slot?: number;
	pc?: RTCPeerConnection;
	ws?: WebSocket;
	key?: Uint8Array;

	// signalPromise is fullfilled when we've established a signalling channel
	// and obtained a slot.
	signalPromise: Promise<{ code?: string, pc: RTCPeerConnection }>
	signalResolve?: (result: {code?: string, pc: RTCPeerConnection}) => void
	signalReject?: (reason: string) => void

	// signalPromise is fullfilled when the called is done configuring the
	// PeerConnection object and we can attempt ICE.
	finishPromise?: Promise<void>
	finishResolve?: () => void

	// donePromise is fullfilled when we're done with signalling.
	donePromise?: Promise<Uint8Array>
	doneResolve?: (fingerprint: Uint8Array) => void
	doneReject?: (reason: string) => void

	constructor(signalserver: string, code: string) {
		if (code !== "") {
			[this.slot, this.pass] = webwormhole.decode(code);
			if (this.pass.length === 0) {
				throw "bad code";
			}
			console.log("dialling slot:", this.slot);
			this.state = "b";
		} else {
			this.pass = crypto.getRandomValues(new Uint8Array(2));
			console.log("requesting slot");
			this.state = "a";
		}

		// There are 4 events that we need to synchronise with the caller on:
		//   1. we got the first message from the signalling server.
		//        We now have the slot number and the ICE server details, so we can
		//        create the wormhole code and PeerConnection object, and pass them back
		//        to the caller to display and configure, respectively.
		//   2. the caller is done configuring the PeerConnection.
		//        We can now create the offer or answer and send it to the peer.
		//   3. we've successfully authenticated the other peer.
		//        Signalling is now done, apart from trickling candidates. The caller
		//        can display the key fingerprint.
		//   4. caller tells us the webrtc handshake is done. We can close the websocket.

		this.signalPromise = new Promise((signalResolve, signalReject) => {
			this.finishPromise = new Promise((finishResolve, finishReject) => {
				this.donePromise = new Promise((doneResolve, doneReject) => {
					this.signalResolve = signalResolve;
					this.signalReject = signalReject;
					this.finishResolve = finishResolve;
					this.doneResolve = doneResolve;
					this.doneReject = doneReject;
					this.dial(signalserver);
				});
			});
		});
	}

	async signal() {
		return this.signalPromise;
	}

	async finish() {
		if (this.finishResolve) this.finishResolve();
		return this.donePromise;
	}

	async close() {
		if (!this.ws || !this.pc) { return }

		switch (this.pc.iceConnectionState) {
			case "connected": {
				const connType = await this.connType();
				// TODO UI to warn if relay is used.
				console.log("webrtc connected:", connType);
				switch (connType) {
					case "host":
					case "srflx":
					case "prflx": {
						this.ws.close(WormholeErrorCodes.closeWebRTCSuccessDirect);
						break;
					}
					case "relay": {
						this.ws.close(WormholeErrorCodes.closeWebRTCSuccessRelay);
						break;
					}
					default: {
						this.ws.close(WormholeErrorCodes.closeWebRTCSuccess);
						break;
					}
				}
				break;
			}
			case "failed": {
				this.ws.close(WormholeErrorCodes.closeWebRTCFailed);
				break;
			}
		}
	}

	async connType(): Promise<string> {
		if (!this.pc) { return "" }

		// RTCStatsReport.forEach is all that's defined in the TypeScript DOM defs, which
		// makes this kind of awkward. Ah well.
		const stats = await this.pc.getStats();

		let id: string | undefined;
		stats.forEach(s => {
			// s.selected gives more confidenece than s.state == "succeeded", but Chrome does
			// not implement it.
			if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).state === "succeeded") {
				id = (s as RTCIceCandidatePairStats).localCandidateId
			}
		})

		if (!id) {
			return ""
		}

		let conntype: string = ""
		stats.forEach(s => {
			if (s.id === id) {
				conntype = (s as {candidateType: string}).candidateType;
			}
		})

		return conntype
	}

	dial(signalserver: string) {
		this.ws = new WebSocket(
			Wormhole.wsserver(signalserver, this.slot),
			Wormhole.protocol,
		);
		// Use lambdas so that 'this' in the respective bodies refers to the Wormhole
		// instance, and not the WebSocket one.
		this.ws.onopen = () => this.onopen();
		this.ws.onerror = (e: Event) => this.onerror(e);
		this.ws.onclose = (e: CloseEvent) => this.onclose(e);
		this.ws.onmessage = (e: MessageEvent) => this.onmessage(e);
	}

	onmessage(m: MessageEvent) {
		if (!this.ws) { return }

		// This all being so asynchronous makes it so the only way apparent to
		// me to describe the PAKE and WebRTC message exchange state machine
		// a big case statement. I'd welcome a clearer or more idiomatic approach
		// in JS if someone were to suggest one.
		switch (this.state) {
			case "a": {
				const msg: {slot: string, iceServers: GoICEServers} = JSON.parse(m.data);

				console.log("assigned slot:", msg.slot);
				this.slot = parseInt(msg.slot, 10);
				if (!Number.isSafeInteger(this.slot)) {
					this.fail("invalid slot");
					return;
				}
				this.makePeerConnection(msg.iceServers);
				if (this.signalResolve) this.signalResolve({
					code: webwormhole.encode(this.slot, this.pass),
					pc: this.pc as RTCPeerConnection,
				});
				this.state = "wait_for_pake_a";
				return;
			}

			case "b": {
				const msg: {iceServers: GoICEServers} = JSON.parse(m.data);

				this.makePeerConnection(msg.iceServers);
				if (this.signalResolve) this.signalResolve({
					pc: this.pc as RTCPeerConnection,
				});
				const msgA = webwormhole.start(this.pass);
				if (msgA == null) {
					this.fail("couldn't generate A's PAKE message");
					return;
				}
				console.log("message a:", msgA);
				this.ws.send(msgA);
				this.state = "wait_for_pake_b";
				return;
			}

			case "wait_for_pake_a": {
				if (!this.pc) { return }

				console.log("got pake message a:", m.data);
				let msgB;
				[this.key, msgB] = webwormhole.exchange(this.pass, m.data);
				console.log("message b:", msgB);
				if (!this.key) {
					this.fail("could not generate key");
					return;
				}
				console.log("generated key");
				this.ws.send(msgB);
				this.state = "wait_for_pc_initialize";
				if (this.finishPromise) this.finishPromise.then(async () => {
					if (!this.ws || !this.key || !this.pc) { return }

					const offer = await this.pc.createOffer();
					console.log("created offer");
					this.ws.send(webwormhole.seal(this.key, JSON.stringify(offer)));
					this.state = "wait_for_webtc_answer";
					this.pc.setLocalDescription(offer);
				});
				return;
			}

			case "wait_for_pake_b": {
				console.log("got pake message b:", m.data);
				this.key = webwormhole.finish(m.data);
				if (!this.key) {
					this.fail("could not generate key");
					return;
				}
				console.log("generated key");
				this.state = "wait_for_webtc_offer";
				return;
			}

			case "wait_for_webtc_offer": {
				if (!this.key || !this.pc) { return }

				const msg: RTCSessionDescriptionInit | null = JSON.parse(webwormhole.open(this.key, m.data));
				if (!msg) {
					this.fail("bad key");
					this.ws.send(webwormhole.seal(this.key, "bye"));
					this.ws.close(WormholeErrorCodes.closeBadKey);
					return;
				}
				if (msg.type !== "offer") {
					console.log("unexpected message", msg);
					this.fail("unexpected message");
					return;
				}
				console.log("got offer");
				// No intermediate state wait_for_pc_initialize because candidates can
				// staring arriving straight after the offer is sent.
				this.state = "wait_for_candidates";
				if (this.finishPromise) this.finishPromise.then(async () => {
					if (!this.ws || !this.key || !this.pc) { return }

					await this.pc.setRemoteDescription(new RTCSessionDescription(msg));
					const answer = await this.pc.createAnswer();
					console.log("created answer");
					this.ws.send(webwormhole.seal(this.key, JSON.stringify(answer)));
					if (this.doneResolve) this.doneResolve(webwormhole.fingerprint(this.key));
					this.pc.setLocalDescription(answer);
				});
				return;
			}

			case "wait_for_webtc_answer": {
				if (!this.key || !this.pc) { return }

				const msg: RTCSessionDescriptionInit | null = JSON.parse(webwormhole.open(this.key, m.data));
				if (!msg) {
					this.fail("bad key");
					this.ws.send(webwormhole.seal(this.key, "bye"));
					this.ws.close(WormholeErrorCodes.closeBadKey);
					return;
				}
				if (msg.type !== "answer") {
					console.log("unexpected message", msg);
					this.fail("unexpected message");
					return;
				}
				console.log("got answer");
				this.pc.setRemoteDescription(new RTCSessionDescription(msg));
				if (this.doneResolve) this.doneResolve(webwormhole.fingerprint(this.key));
				this.state = "wait_for_candidates";
				return;
			}

			case "wait_for_candidates": {
				if (!this.key || !this.pc) { return }

				const msg: {candidate: string} | null = JSON.parse(webwormhole.open(this.key, m.data));
				if (!msg) {
					this.fail("bad key");
					this.ws.send(webwormhole.seal(this.key, "bye"));
					this.ws.close(WormholeErrorCodes.closeBadKey);
					return;
				}
				console.log("got remote candidate", msg.candidate);
				if (this.finishPromise) this.finishPromise.then(async () => {
					if (!this.key || !this.pc) { return }
					this.pc.addIceCandidate(new RTCIceCandidate(msg));
				});
				return;
			}

			case "wait_for_pc_initialize":
			case "wait_for_local_offer":
			case "wait_for_local_answer": {
				console.log("unexpected message", m);
				this.fail("unexpected message");
				return;
			}
			case "error":
				return;
		}
	}

	makePeerConnection(iceServers: GoICEServers) {
		let normalisedICEServers = [];
		for (let i = 0; i < iceServers.length; i++) {
			normalisedICEServers.push({
				urls: iceServers[i].URLs,
				username: iceServers[i].Username,
				credential: iceServers[i].Credential,
			});
		}
		this.pc = new RTCPeerConnection({
			iceServers: normalisedICEServers,
		});
		this.pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
			if (!this.ws || !this.key || !this.pc) { return }

			if (e.candidate && e.candidate.candidate !== "") {
				console.log("got local candidate", e.candidate.candidate);
				this.ws.send(webwormhole.seal(this.key, JSON.stringify(e.candidate)));
			}
		};
	}

	onopen() {
		console.log("websocket session established");
	}

	onerror(e: Event) {
		console.log("websocket session error:", e);
		this.fail("could not connect to signalling server");
	}

	onclose(e: CloseEvent) {
		if (e.code === 4_000) {
			this.fail("no such slot");
		} else if (e.code === 4_001) {
			this.fail("timed out");
		} else if (e.code === 4_002) {
			this.fail("could not get slot");
		} else if (e.code === 4_003) {
			this.fail("wrong protocol version, must update");
		} else if (e.code === 4_004 || e.code === 1_001) {
			// Workaround for regression introduced in firefox around version ~78.
			// Usually the websocket connection stays open for the duration of the session, since
			// it doesn't hurt and it make candidate trickling easier. We only do this here out of
			// laziness. The go code has more disciplined websocket lifecycle management.
			// Recent versions of Firefox introduced a bug where websocket connections are killed
			// when a download begins. This would happen after the WebRTC connection is set up
			// so it's not really an error we need to react to.
		} else {
			this.fail(`websocket session closed: ${e.reason} (${e.code})`);
		}
	}

	fail(reason: string) {
		if (this.signalReject) this.signalReject(reason);
		if (this.doneReject) this.doneReject(reason);
		this.state = "error";
	}

	// wsserver creates a WebSocket scheme (ws: or wss:) URL from an HTTP one.
	static wsserver(url: string, slot?: number) {
		const u = new URL(url);
		let protocol = "wss:";
		if (u.protocol === "http:") {
			protocol = "ws:";
		}
		let path = u.pathname;
		if (!path.startsWith("/")) {
			path = `/${path}`;
		}
		if (slot) {
			path = `${path}${slot}`;
		}
		return `${protocol}//${u.host}${path}`;
	}

	// WASM loads the WebAssembly part from url.
	static async WASM(url: string) {
		// Polyfill for Safari WASM streaming.
		if (!WebAssembly.instantiateStreaming) {
			WebAssembly.instantiateStreaming = async (resp, importObject) => {
				const source = await (await resp).arrayBuffer();
				return await WebAssembly.instantiate(source, importObject);
			};
		}
		const go = new Go();
		const wasm = await WebAssembly.instantiateStreaming(
			fetch(url),
			go.importObject,
		);
		go.run(wasm.instance);
	}
}
