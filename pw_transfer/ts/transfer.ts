// Copyright 2021 The Pigweed Authors
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not
// use this file except in compliance with the License. You may obtain a copy of
// the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
// License for the specific language governing permissions and limitations under
// the License.

import {
  BidirectionalStreamingCall,
  BidirectionalStreamingMethodStub,
  ServiceClient,
} from '@pigweed/pw_rpc';
import {Status} from '@pigweed/pw_status';
import {Chunk} from 'transfer_proto_tspb/transfer_proto_tspb_pb/pw_transfer/transfer_pb';

/** A Timer which invokes a callback after a certain timeout. */
class Timer {
  private task?: ReturnType<typeof setTimeout>;

  constructor(
    readonly timeoutS: number,
    private readonly callback: () => any
  ) {}

  /**
   * Starts a new timer.
   *
   * If a timer is already running, it is stopped and a new timer started.
   * This can be used to implement watchdog-like behavior, where a callback
   * is invoked after some time without a kick.
   */
  start() {
    this.stop();
    this.task = setTimeout(this.callback, this.timeoutS * 1000);
  }

  /** Terminates a running timer. */
  stop() {
    if (this.task !== undefined) {
      clearTimeout(this.task);
      this.task = undefined;
    }
  }
}

/**
 * A client-side data transfer through a Manager.
 *
 * Subclasses are responsible for implementing all of the logic for their type
 * of transfer, receiving messages from the server and sending the appropriate
 * messages in response.
 */
export abstract class Transfer {
  status: Status = Status.OK;

  protected data = new Uint8Array();

  private retries = 0;
  private responseTimer?: Timer;

  done: Promise<Status>;
  private resolve?: (value: Status | PromiseLike<Status>) => void;

  constructor(
    public id: number,
    protected sendChunk: (chunk: Chunk) => void,
    responseTimeoutS: number,
    private maxRetries: number
  ) {
    this.responseTimer = new Timer(responseTimeoutS, this.onTimeout);
    this.done = new Promise<Status>(resolve => {
      this.resolve = resolve!;
    });
  }

  /** Returns the initial chunk to notify the server of the transfer. */
  protected abstract get initialChunk(): Chunk;

  /** Handles a chunk that contains or requests data. */
  protected abstract handleDataChunk(chunk: Chunk): void;

  /** Retries after a timeout occurs. */
  protected abstract retryAfterTimeout(): void;

  /** Handles a timeout while waiting for a chunk. */
  private onTimeout = () => {
    this.retries += 1;
    if (this.retries > this.maxRetries) {
      this.finish(Status.DEADLINE_EXCEEDED);
      return;
    }

    console.debug(
      `Received no responses for ${this.responseTimer?.timeoutS}; retrying ${this.retries}/${this.maxRetries}`
    );

    this.retryAfterTimeout();
    this.responseTimer?.start();
  };

  /** Sends an error chunk to the server and finishes the transfer. */
  protected sendError(error: Status): void {
    const chunk = new Chunk();
    chunk.setStatus(error);
    chunk.setTransferId(this.id);
    this.sendChunk(chunk);
    this.finish(error);
  }

  /** Sends the initial chunk of the transfer. */
  begin(): void {
    this.sendChunk(this.initialChunk);
    this.responseTimer?.start();
  }

  /** Ends the transfer with the specified status. */
  finish(status: Status): void {
    this.responseTimer?.stop();
    this.responseTimer = undefined;
    this.status = status;

    if (status === Status.OK) {
      const totalSize = this.data.length;
    }

    this.resolve!(this.status);
  }

  /**
   *  Processes an incoming chunk from the server.
   *
   *  Handles terminating chunks (i.e. those with a status) and forwards
   *  non-terminating chunks to handle_data_chunk.
   */
  handleChunk(chunk: Chunk): void {
    this.responseTimer?.stop();
    this.retries = 0; // Received data from service, so reset the retries.

    console.debug(`Received chunk:(${chunk})`);

    // Status chunks are only used to terminate a transfer. They do not
    // contain any data that requires processing.
    if (chunk.hasStatus()) {
      this.finish(chunk.getStatus());
      return;
    }

    this.handleDataChunk(chunk);

    // Start the timeout for the server to send a chunk in response.
    this.responseTimer?.start();
  }
}

/**
 * A client <= server read transfer.
 *
 * Although typescript can effectively handle an unlimited transfer window, this
 * client sets a conservative window and chunk size to avoid overloading the
 * device. These are configurable in the constructor.
 */
export class ReadTransfer extends Transfer {
  private maxBytesToReceive: number;
  private maxChunkSize: number;
  private chunkDelayMicroS?: number; // Microseconds
  private remainingTransferSize?: number;
  private offset = 0;
  private pendingBytes: number;

  data = new Uint8Array();

  constructor(
    id: number,
    sendChunk: (chunk: Chunk) => void,
    responseTimeoutS: number,
    maxRetries: number,
    maxBytesToReceive = 8192,
    maxChunkSize = 1024,
    chunkDelayMicroS?: number
  ) {
    super(id, sendChunk, responseTimeoutS, maxRetries);
    this.maxBytesToReceive = maxBytesToReceive;
    this.maxChunkSize = maxChunkSize;
    this.chunkDelayMicroS = chunkDelayMicroS;
    this.pendingBytes = maxBytesToReceive;
  }

  protected get initialChunk(): Chunk {
    return this.transferParameters();
  }

  /** Builds an updated transfer parameters chunk to send the server. */
  private transferParameters(): Chunk {
    this.pendingBytes = this.maxBytesToReceive;

    const chunk = new Chunk();
    chunk.setTransferId(this.id);
    chunk.setPendingBytes(this.pendingBytes);
    chunk.setMaxChunkSizeBytes(this.maxChunkSize);
    chunk.setOffset(this.offset);

    if (this.chunkDelayMicroS !== 0) {
      chunk.setMinDelayMicroseconds(this.chunkDelayMicroS!);
    }
    return chunk;
  }

  /**
   * Processes an incoming chunk from the server.
   *
   * In a read transfer, the client receives data chunks from the server.
   * Once all pending data is received, the transfer parameters are updated.
   */
  protected handleDataChunk(chunk: Chunk): void {
    if (chunk.getOffset() != this.offset) {
      // Initially, the transfer service only supports in-order transfers.
      // If data is received out of order, request that the server
      // retransmit from the previous offset.
      this.pendingBytes = 0;
      this.sendChunk(this.transferParameters());
      return;
    }

    const oldData = this.data;
    const chunkData = chunk.getData() as Uint8Array;
    this.data = new Uint8Array(chunkData.length + oldData.length);
    this.data.set(oldData);
    this.data.set(chunkData, oldData.length);

    this.pendingBytes -= chunk.getData().length;
    this.offset += chunk.getData().length;

    if (chunk.hasRemainingBytes()) {
      if (chunk.getRemainingBytes() === 0) {
        // No more data to read. Aknowledge receipt and finish.
        const endChunk = new Chunk();
        endChunk.setTransferId(this.id);
        endChunk.setStatus(Status.OK);
        this.sendChunk(endChunk);
        this.finish(Status.OK);
        return;
      }

      this.remainingTransferSize = chunk.getRemainingBytes();
    } else if (this.remainingTransferSize !== undefined) {
      // Update the remaining transfer size, if it is known.
      this.remainingTransferSize -= chunk.getData().length;

      if (this.remainingTransferSize <= 0) {
        this.remainingTransferSize = undefined;
      }
    }

    if (this.pendingBytes === 0) {
      // All pending data was received. Send out a new parameters chunk
      // for the next block.
      this.sendChunk(this.transferParameters());
    }
  }

  protected retryAfterTimeout(): void {
    this.sendChunk(this.transferParameters());
  }
}

/**
 * A client => server write transfer.
 */
export class WriteTransfer extends Transfer {
  readonly data: Uint8Array;
  private windowId = 0;
  offset = 0;
  maxChunkSize = 0;
  chunkDelayMicroS?: number;
  maxBytesToSend = 0;
  lastChunk: Chunk;

  constructor(
    id: number,
    data: Uint8Array,
    sendChunk: (chunk: Chunk) => void,
    responseTimeoutS: number,
    initialResponseTimeoutS: number,
    maxRetries: number
  ) {
    super(id, sendChunk, responseTimeoutS, maxRetries);
    this.data = data;
    this.lastChunk = this.initialChunk;
  }

  protected get initialChunk(): Chunk {
    const chunk = new Chunk();
    chunk.setTransferId(this.id);
    return chunk;
  }

  /**
   * Processes an incoming chunk from the server.
   *
   * In a write transfer, the server only sends transfer parameter updates
   * to the client. When a message is received, update local parameters and
   * send data accordingly.
   */
  protected handleDataChunk(chunk: Chunk): void {
    this.windowId += 1;
    const initialWindowId = this.windowId;

    if (!this.handleParametersUpdate(chunk)) {
      return;
    }

    const bytesAknowledged = chunk.getOffset();

    let writeChunk: Chunk;
    while (true) {
      writeChunk = this.nextChunk();
      this.offset += writeChunk.getData().length;
      this.maxBytesToSend -= writeChunk.getData().length;
      const sentRequestedBytes = this.maxBytesToSend === 0;

      this.sendChunk(writeChunk);
      if (sentRequestedBytes) {
        break;
      }
    }

    this.lastChunk = writeChunk;
  }

  /** Updates transfer state base on a transfer parameters update. */
  private handleParametersUpdate(chunk: Chunk): boolean {
    if (chunk.getOffset() > this.data.length) {
      // Bad offset; terminate the transfer.
      console.error(
        `Transfer ${
          this.id
        }: server requested invalid offset ${chunk.getOffset()} (size ${
          this.data.length
        })`
      );

      this.sendError(Status.OUT_OF_RANGE);
      return false;
    }

    if (chunk.getPendingBytes() === 0) {
      console.error(
        `Transfer ${this.id}: service requested 0 bytes (invalid); aborting`
      );
      this.sendError(Status.INTERNAL);
      return false;
    }

    // Check whether the client has sent a previous data offset, which
    // indicates that some chunks were lost in transmission.
    if (chunk.getOffset() < this.offset) {
      console.debug(
        `Write transfer ${
          this.id
        } rolling back to offset ${chunk.getOffset()} from ${this.offset}`
      );
    }

    this.offset = chunk.getOffset();
    this.maxBytesToSend = Math.min(
      chunk.getPendingBytes(),
      this.data.length - this.offset
    );

    if (chunk.hasMaxChunkSizeBytes()) {
      this.maxChunkSize = chunk.getMaxChunkSizeBytes();
    }

    if (chunk.hasMinDelayMicroseconds()) {
      this.chunkDelayMicroS = chunk.getMinDelayMicroseconds();
    }
    return true;
  }

  /** Returns the next Chunk message to send in the data transfer. */
  private nextChunk(): Chunk {
    const chunk = new Chunk();
    chunk.setTransferId(this.id);
    chunk.setOffset(this.offset);
    const maxBytesInChunk = Math.min(this.maxChunkSize, this.maxBytesToSend);

    chunk.setData(this.data.slice(this.offset, this.offset + maxBytesInChunk));

    // Mark the final chunk of the transfer.
    if (this.data.length - this.offset <= maxBytesInChunk) {
      chunk.setRemainingBytes(0);
    }
    return chunk;
  }

  protected retryAfterTimeout(): void {
    this.sendChunk(this.lastChunk);
  }
}
