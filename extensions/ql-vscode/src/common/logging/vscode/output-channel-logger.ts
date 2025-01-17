import { window as Window, OutputChannel, Progress } from "vscode";
import { Logger, LogOptions } from "../logger";
import { DisposableObject } from "../../../pure/disposable-object";

/**
 * A logger that writes messages to an output channel in the VS Code Output tab.
 */
export class OutputChannelLogger extends DisposableObject implements Logger {
  public readonly outputChannel: OutputChannel;
  isCustomLogDirectory: boolean;

  constructor(title: string) {
    super();
    this.outputChannel = Window.createOutputChannel(title);
    this.push(this.outputChannel);
    this.isCustomLogDirectory = false;
  }

  async log(message: string, options = {} as LogOptions): Promise<void> {
    try {
      if (options.trailingNewline === undefined) {
        options.trailingNewline = true;
      }
      if (options.trailingNewline) {
        this.outputChannel.appendLine(message);
      } else {
        this.outputChannel.append(message);
      }
    } catch (e) {
      if (e instanceof Error && e.message === "Channel has been closed") {
        // Output channel is closed logging to console instead
        console.log(
          "Output channel is closed logging to console instead:",
          message,
        );
      } else {
        throw e;
      }
    }
  }

  show(preserveFocus?: boolean): void {
    this.outputChannel.show(preserveFocus);
  }
}

export type ProgressReporter = Progress<{ message: string }>;
